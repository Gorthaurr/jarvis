/**
 * C4/B5 аудита прод-логов 27.09: 26.09 durable-лог клиента молча потерял ~10,7 ч — flush() забирал буфер ДО
 * appendFileSync и глотал ошибку (ни строки в консоль, ни запасного файла). Причина самого сбоя записи внешняя
 * и по логам не установлена; здесь основной файл дня блокируем КАТАЛОГОМ с тем же именем — настоящая ошибка ФС
 * (EISDIR/EPERM), не мок — и блокируем ДО первого флаша: 26.09 не легла даже стартовая строка «durable-лог включён».
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);

import { ClientFileLogSink, pruneOldClientLogs } from "./file-log.js";

/** Локальная дата YYYY-MM-DD — как в имени файла дня у sink. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const entry = (msg: string) => ({ ts: Date.now(), level: "info" as const, scope: "test", msg });
const msgsIn = (file: string): string[] =>
  readFileSync(file, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { msg: string }).msg);
/** Код ошибки, которую ФС отдаёт на append в этот путь (платформо-независимо: EISDIR на Linux, EPERM/EISDIR на Windows). */
function appendErrorCode(path: string): string | undefined {
  try {
    appendFileSync(path, "проба\n"); // пустая строка на Windows не доходит до write — ошибки бы не было
  } catch (e) {
    return (e as NodeJS.ErrnoException).code;
  }
  return undefined;
}

describe("ClientFileLogSink — сбой записи не теряет строки молча (C4/B5 27.09)", () => {
  let dir: string;
  let primary: string;
  let fallback: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const fileLogWarns = () => warn.mock.calls.filter((c) => String(c[0]).includes("(client:file-log)"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-client-filelog-"));
    primary = join(dir, `client-${today()}.log`);
    fallback = join(dir, `client-${today()}.${process.pid}.log`);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("основной файл недоступен с первого флаша → строки уходят в запасной client-<день>.<pid>.log, стартовая первой; предупреждений ровно два", () => {
    mkdirSync(primary); // основной файл дня занят (каталог с тем же именем)
    const code = appendErrorCode(primary);
    expect(code).toBeTruthy();
    const s = new ClientFileLogSink({ dir });
    const sent: string[] = [];
    for (let i = 0; i < 10; i++) {
      const msg = i === 0 ? "durable-лог клиента включён" : `строка ${i}`;
      sent.push(msg);
      s.sink(entry(msg));
      s.flush();
    }
    expect(existsSync(fallback)).toBe(true);
    expect(msgsIn(fallback)).toEqual(sent); // ни одна не потеряна, порядок сохранён
    // Одно — на первый сбой (с кодом ошибки), одно — на переход в запасной файл. НЕ по предупреждению на флаш.
    const warns = fileLogWarns();
    expect(warns).toHaveLength(2);
    expect(warns[0]![1]).toMatchObject({ code, file: primary });
    expect(warns[1]![1]).toMatchObject({ file: fallback });
  });

  it("основной ожил → отложенные строки дописываются в него по порядку, даже без новых строк (пустой буфер)", () => {
    mkdirSync(primary);
    const s = new ClientFileLogSink({ dir });
    s.sink(entry("A"));
    s.flush(); // сбой 1: A отложена
    s.sink(entry("B"));
    s.flush(); // сбой 2: A, B отложены
    expect(existsSync(fallback)).toBe(false); // до N подряд сбоев запасной не нужен
    rmSync(primary, { recursive: true }); // файл освободился
    s.flush(); // новых строк нет — отложенные всё равно должны лечь
    expect(msgsIn(primary)).toEqual(["A", "B"]);
    s.sink(entry("C"));
    s.dispose(); // выход приложения — хвост дописан туда же
    expect(msgsIn(primary)).toEqual(["A", "B", "C"]);
  });

  it("отложенное не возвращается в буфер sink: страж «≥ 2000 строк → флаш» не долбит сбойную запись на каждую строку", () => {
    mkdirSync(primary);
    mkdirSync(fallback); // не пишется ни основной, ни запасной
    const s = new ClientFileLogSink({ dir });
    for (let i = 0; i < 2000; i++) s.sink(entry(`спам ${i}`)); // страж → флаш → сбой 1
    expect(fileLogWarns()).toHaveLength(1);
    for (let i = 0; i < 5; i++) s.sink(entry(`ещё ${i}`)); // флашей быть не должно — до сбоя 3 и «запасной не пишется» не дойдёт
    expect(fileLogWarns()).toHaveLength(1);
  });
});

describe("pruneOldClientLogs — запасные файлы тоже под retention", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-client-prune-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("удаляет старые client-<день>.log и client-<день>.<pid>.log, свежие и чужие оставляет", () => {
    const now = new Date(2026, 8, 27); // 2026-09-27 (локальная)
    for (const n of ["client-2026-09-01.log", "client-2026-09-01.19752.log", "client-2026-09-26.log", "client-2026-09-26.19752.log", "notes.txt"]) {
      writeFileSync(join(dir, n), "x\n");
    }
    pruneOldClientLogs(dir, 7, now);
    expect(existsSync(join(dir, "client-2026-09-01.log"))).toBe(false);
    expect(existsSync(join(dir, "client-2026-09-01.19752.log"))).toBe(false); // иначе запасные копятся вечно
    expect(existsSync(join(dir, "client-2026-09-26.log"))).toBe(true);
    expect(existsSync(join(dir, "client-2026-09-26.19752.log"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});
