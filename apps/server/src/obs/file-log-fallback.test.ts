/**
 * C4/B5 аудита прод-логов 27.09, серверный близнец: FileLogSink.flush() так же забирал буфер ДО appendFileSync и
 * глотал ошибку — пока файл дня не принимал запись, серверный лог терялся бы молча. Сбой здесь настоящий: путь
 * файла дня занят каталогом с тем же именем (append бросает EISDIR/EPERM), заблокирован ДО первого флаша.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("отложенное не возвращается в буфер sink: страж «≥ 2000 строк → флаш» не долбит сбойную запись на каждую строку", () => {
    mkdirSync(primary);
    mkdirSync(fallback); // не пишется ни основной, ни запасной
    const s = new FileLogSink({ dir });
    for (let i = 0; i < 2000; i++) s.sink(entry(`спам ${i}`)); // страж → флаш → сбой 1
    expect(fileLogWarns()).toHaveLength(1);
    for (let i = 0; i < 5; i++) s.sink(entry(`ещё ${i}`)); // флашей быть не должно — до сбоя 3 и «запасной не пишется» не дойдёт
    expect(fileLogWarns()).toHaveLength(1);
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
