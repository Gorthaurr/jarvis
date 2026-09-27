/**
 * C4/B5 аудита прод-логов 27.09, серверный близнец: FileLogSink.flush() так же забирал буфер ДО appendFileSync и
 * глотал ошибку — пока файл дня не принимал запись, серверный лог терялся бы молча. Сбой здесь настоящий: путь
 * файла дня занят каталогом с тем же именем (append бросает EISDIR/EPERM), заблокирован ДО первого флаша.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLogSink, createLogger } from "@jarvis/shared";
import { FileLogSink, pruneOldLogs } from "./file-log.js";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const entry = (msg: string) => ({ ts: Date.now(), level: "info" as const, scope: "test", msg });
const msgsIn = (file: string): string[] =>
  readFileSync(file, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { msg: string }).msg);
function appendErrorCode(path: string): string | undefined {
  try {
    appendFileSync(path, "проба\n"); // пустая строка на Windows не доходит до write — ошибки бы не было
  } catch (e) {
    return (e as NodeJS.ErrnoException).code;
  }
  return undefined;
}

describe("FileLogSink — сбой записи не теряет строки молча (C4/B5 27.09)", () => {
  let dir: string;
  let primary: string;
  let fallback: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const fileLogWarns = () => warn.mock.calls.filter((c) => String(c[0]).includes("(obs:file-log)"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-filelog-fb-"));
    primary = join(dir, `server-${today()}.log`);
    fallback = join(dir, `server-${today()}.${process.pid}.log`);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("файл дня недоступен с первого флаша → строки уходят в запасной server-<день>.<pid>.log по порядку; предупреждений ровно два", () => {
    mkdirSync(primary);
    const code = appendErrorCode(primary);
    expect(code).toBeTruthy();
    const s = new FileLogSink({ dir });
    const sent: string[] = [];
    for (let i = 0; i < 10; i++) {
      sent.push(`строка ${i}`);
      s.sink(entry(`строка ${i}`));
      s.flush();
    }
    expect(existsSync(fallback)).toBe(true);
    expect(msgsIn(fallback)).toEqual(sent);
    const warns = fileLogWarns();
    expect(warns).toHaveLength(2);
    expect(warns[0]![1]).toMatchObject({ code, file: primary });
    expect(warns[1]![1]).toMatchObject({ file: fallback });
  });

  it("файл ожил → отложенное дописывается по порядку, даже на флаше без новых строк и на dispose", () => {
    mkdirSync(primary);
    const s = new FileLogSink({ dir });
    s.sink(entry("A"));
    s.flush();
    s.sink(entry("B"));
    s.flush();
    rmSync(primary, { recursive: true });
    s.flush();
    expect(msgsIn(primary)).toEqual(["A", "B"]);
    s.sink(entry("C"));
    s.dispose();
    expect(msgsIn(primary)).toEqual(["A", "B", "C"]);
  });

  it("dispose с пустым буфером, но отложенным после сбоя → отложенное всё равно уходит (в запасной)", () => {
    mkdirSync(primary);
    const s = new FileLogSink({ dir });
    s.sink(entry("A"));
    s.flush(); // сбой 1: A отложена, буфер sink пуст
    s.dispose();
    expect(msgsIn(fallback)).toEqual(["A"]);
  });

  it("отложенное не возвращается в буфер sink: страж «≥ 2000 строк → флаш» не долбит сбойную запись на каждую строку", () => {
    mkdirSync(primary);
    mkdirSync(fallback); // не пишется ни основной, ни запасной
    const s = new FileLogSink({ dir });
    for (let i = 0; i < 2000; i++) s.sink(entry(`спам ${i}`)); // страж → флаш → сбой 1
    expect(fileLogWarns()).toHaveLength(1);
    for (let i = 0; i < 5; i++) s.sink(entry(`ещё ${i}`)); // флашей быть не должно — до сбоя 3 и «запасной не пишется» не дойдёт
    expect(fileLogWarns()).toHaveLength(1);
  });

  it("каталог логов удалили на ходу → пересоздан, строка легла в основной без предупреждений", () => {
    const s = new FileLogSink({ dir });
    rmSync(dir, { recursive: true });
    s.sink(entry("после удаления каталога"));
    s.flush();
    expect(msgsIn(primary)).toEqual(["после удаления каталога"]);
    expect(fileLogWarns()).toHaveLength(0);
  });

  it("pruneOldLogs удаляет и старые запасные server-<день>.<pid>.log", () => {
    const now = new Date(2026, 8, 27);
    for (const n of ["server-2026-09-01.log", "server-2026-09-01.4242.log", "server-2026-09-26.4242.log"]) {
      writeFileSync(join(dir, n), "x\n");
    }
    pruneOldLogs(dir, 7, now);
    expect(existsSync(join(dir, "server-2026-09-01.log"))).toBe(false);
    expect(existsSync(join(dir, "server-2026-09-01.4242.log"))).toBe(false);
    expect(existsSync(join(dir, "server-2026-09-26.4242.log"))).toBe(true);
  });
});

/**
 * р1 (27.09): проводка как в проде — sink зарегистрирован в логгере (addLogSink), поэтому предупреждения самого
 * durable-лога идут через тот же логгер в тот же sink и следующим флашем — в файл. Раньше тесты звали sink() руками.
 */
describe("FileLogSink в логгере (addLogSink) — предупреждения durable-лога сами ложатся в файл", () => {
  let dir: string;
  let primary: string;
  let fallback: string;
  let s: FileLogSink;
  let off: () => void;
  const app = createLogger("test:app");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-filelog-wire-"));
    primary = join(dir, `server-${today()}.log`);
    fallback = join(dir, `server-${today()}.${process.pid}.log`);
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
    mkdirSync(primary); // основной файл дня занят
    s = new FileLogSink({ dir });
    off = addLogSink(s.sink);
  });
  afterEach(() => {
    off();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("основной занят → в запасном и строки, и предупреждения, по порядку; предупреждений под спамом ровно два", () => {
    for (let i = 0; i < 50; i++) {
      app.warn(`спам ${i}`);
      s.flush();
    }
    const msgs = msgsIn(fallback);
    const own = msgs.filter((m) => m.startsWith("durable-лог"));
    expect(own).toHaveLength(2); // первый сбой + переход в запасной — не по строке на флаш
    // Предупреждение о сбое — сразу после первой строки, о переходе — после строки сбоя 3 (порядок событий).
    expect(msgs.slice(0, 5)).toEqual(["спам 0", own[0], "спам 1", "спам 2", own[1]]);
    expect(msgs.filter((m) => m.startsWith("спам"))).toEqual(Array.from({ length: 50 }, (_, i) => `спам ${i}`));
  });

  it("dispose при сбое (фатальный выход до N сбоев подряд) → причина падения и предупреждения — в запасном", () => {
    app.error("FATAL crash line");
    s.dispose();
    expect(msgsIn(fallback)).toEqual(["FATAL crash line", expect.stringMatching(/^durable-лог: запись/), expect.stringMatching(/запасной/)]);
  });

  // р2: основной занят КРАТКО (EBUSY от антивируса) — ожил, пока финальная запись уходила в запасной. Второй проход
  // пишет предупреждения в основной и сам выпускает сводку «снова пишется»; раньше третьего прохода не было — итог
  // инцидента со ссылкой на запасной файл терялся.
  it("основной ожил посреди финальной записи → сводка восстановления со ссылкой на запасной тоже в основном", () => {
    const unblock = addLogSink((e) => {
      if (e.msg.startsWith("durable-лог: запись")) rmSync(primary, { recursive: true, force: true });
    });
    try {
      app.error("FATAL crash line");
      s.dispose();
    } finally {
      unblock();
    }
    expect(msgsIn(fallback)).toEqual(["FATAL crash line"]);
    const recs = readFileSync(primary, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { msg: string; meta?: unknown });
    expect(recs.map((r) => r.msg)).toEqual([expect.stringMatching(/^durable-лог: запись/), expect.stringMatching(/запасной/), expect.stringMatching(/снова пишется/)]);
    expect(recs[2]!.meta).toMatchObject({ fallback, viaFallback: 1, failures: 1 });
  });
});
