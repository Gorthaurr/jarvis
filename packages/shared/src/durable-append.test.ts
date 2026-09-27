/**
 * C4/B5 27.09: политика записи durable-лога на сбой ФС (`durable-append.ts`). Сбой — настоящий: путь файла занят
 * каталогом с тем же именем (append бросает EISDIR/EPERM). Логгер — фейк: его вызовы и есть наблюдаемый выход
 * (в проде это консоль, которую хранитель пишет в client.out.log, и тот же durable-лог).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableAppender } from "./durable-append.js";

describe("DurableAppender", () => {
  let dir: string;
  let primary: string;
  let fallback: string;
  let t: number;
  const log = { warn: vi.fn(), info: vi.fn() };
  const now = () => t;
  const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-durable-append-"));
    primary = join(dir, "client-2026-09-26.log");
    fallback = join(dir, "client-2026-09-26.19752.log");
    t = 0;
    log.warn.mockReset();
    log.info.mockReset();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("не пишутся ни основной, ни запасной → держим не больше потолка, выкидываем СТАРЫЕ и считаем; ожил → свежие легли, сводка с потерей", () => {
    mkdirSync(primary);
    mkdirSync(fallback);
    const a = new DurableAppender(log, { fallbackAfter: 1, maxPending: 3, now });
    a.write(primary, fallback, ["1", "2"]);
    a.write(primary, fallback, ["3", "4", "5"]);
    expect(a.idle).toBe(false);
    // Первый сбой + «запасной тоже не пишется» — по одному разу; дальше тишина до напоминания.
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1]![1]).toMatchObject({ file: fallback });
    rmSync(primary, { recursive: true });
    a.write(primary, fallback, []); // новых строк нет — отложенное всё равно дописывается
    expect(lines(primary)).toEqual(["3", "4", "5"]);
    expect(a.idle).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![1]).toMatchObject({ file: primary, failures: 2, lost: 2 });
  });

  it("напоминание о продолжающемся сбое — не чаще warnEveryMs и со счётчиками", () => {
    mkdirSync(primary);
    const a = new DurableAppender(log, { fallbackAfter: 100, warnEveryMs: 60_000, now });
    for (const at of [0, 1_000, 59_999]) {
      t = at;
      a.write(primary, fallback, [`в ${at}`]);
    }
    expect(log.warn).toHaveBeenCalledTimes(1); // только первый сбой
    t = 60_000;
    a.write(primary, fallback, ["минута"]);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1]![1]).toMatchObject({ failures: 4, pending: 4, lost: 0 });
    t = 60_001;
    a.write(primary, fallback, ["ещё"]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("счёт «N сбоев подряд» сбрасывается удачной записью: новый инцидент начинается с первого предупреждения, а не с запасного", () => {
    const a = new DurableAppender(log, { fallbackAfter: 2, now });
    mkdirSync(primary);
    a.write(primary, fallback, ["A"]); // сбой 1
    rmSync(primary, { recursive: true });
    a.write(primary, fallback, ["B"]); // ожил
    expect(lines(primary)).toEqual(["A", "B"]);
    rmSync(primary);
    mkdirSync(primary);
    a.write(primary, fallback, ["C"]); // снова сбой — это сбой 1 нового инцидента
    expect(existsSync(fallback)).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1]![0]).toBe(log.warn.mock.calls[0]![0]); // то же «первое» сообщение
    a.write(primary, fallback, ["D"]); // сбой 2 → запасной
    expect(lines(fallback)).toEqual(["C", "D"]);
    expect(log.warn).toHaveBeenCalledTimes(3); // + «пишу в запасной»
    a.write(primary, fallback, ["E"]); // уже на запасном — о переходе второй раз не говорим
    expect(lines(fallback)).toEqual(["C", "D", "E"]);
    expect(log.warn).toHaveBeenCalledTimes(3);
  });
});
