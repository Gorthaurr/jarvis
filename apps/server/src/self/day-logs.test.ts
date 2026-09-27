/**
 * р2 ревью C4/B5 (27.09): дневные логи для самодиагностики. Файлы — настоящие (tmpdir), время изменения задаём
 * utimesSync: «новее» = mtime, а не имя (`.4242.log` по имени идёт РАНЬШЕ основного `.log`).
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDayLogs } from "./day-logs.js";

const DAY = "2026-09-26";
/** Строки одной длины: ts внутри дня, msg `f<NN> <i>` (файл, номер строки). */
const line = (file: number, i: number, hh = String(10 + (i % 10)).padStart(2, "0")) =>
  JSON.stringify({ ts: `${DAY}T${hh}:00:00.000Z`, level: "warn", msg: `f${String(file).padStart(2, "0")} ${i}` });

describe("readDayLogs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-day-logs-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Файл дня с `n` строками; mtime = база + k минут (k больше — новее). Возвращает имя и длину содержимого. */
  function dayFile(name: string, file: number, n: number, k: number): { name: string; size: number } {
    const text = `${Array.from({ length: n }, (_, i) => line(file, i)).join("\n")}\n`;
    writeFileSync(join(dir, name), text);
    const t = new Date(2026, 8, 26, 12, k);
    utimesSync(join(dir, name), t, t);
    return { name, size: text.length };
  }

  it("крэш-луп: десятки запасных файлов дня — читаем от новых к старым в пределах бюджета ДНЯ, остальные не трогаем", async () => {
    // 30 pid-файлов по 5 строк; основной — самый старый. Бюджет дня = ровно 3 файла.
    const files = [dayFile(`server-${DAY}.log`, 0, 5, 0)];
    for (let f = 1; f < 30; f++) files.push(dayFile(`server-${DAY}.${1000 + f}.log`, f, 5, f));
    const r = await readDayLogs(dir, files.map((x) => x.name), 1, files[0]!.size * 3);
    expect(r.days).toBe(1);
    const got = new Set(r.entries.map((e) => String(e.msg).slice(0, 3)));
    expect([...got].sort()).toEqual(["f27", "f28", "f29"]); // три самых новых — целиком, старые не разобраны
    expect(r.entries).toHaveLength(15);
  });

  it("бюджет кончается посреди файла → из него берётся ХВОСТ (свежие строки), битая первая строка отброшена", async () => {
    const old = dayFile(`server-${DAY}.log`, 0, 10, 0);
    dayFile(`server-${DAY}.4242.log`, 1, 10, 1);
    dayFile(`server-${DAY}.5555.log`, 2, 10, 2);
    const r = await readDayLogs(dir, [`server-${DAY}.log`, `server-${DAY}.4242.log`, `server-${DAY}.5555.log`], 1, Math.floor(old.size * 1.5));
    const msgs = r.entries.map((e) => String(e.msg));
    expect(msgs.filter((m) => m.startsWith("f02"))).toHaveLength(10); // самый новый — целиком
    const mid = msgs.filter((m) => m.startsWith("f01")).map((m) => Number(m.slice(4)));
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.length).toBeLessThan(10);
    expect(Math.max(...mid)).toBe(9); // хвост файла, а не голова
    expect(msgs.some((m) => m.startsWith("f00"))).toBe(false); // на самый старый бюджета не осталось
  });

  it("один файл в дне — порядок файла как есть, без сортировки и без разбора ts", async () => {
    const hh = ["12", "09", "10"];
    writeFileSync(join(dir, `server-${DAY}.log`), hh.map((h, i) => line(0, i, h)).join("\n"));
    const parse = vi.spyOn(Date, "parse");
    const r = await readDayLogs(dir, [`server-${DAY}.log`], 1, 1_000_000);
    expect(r.entries.map((e) => String(e.ts).slice(11, 13))).toEqual(hh);
    expect(parse).not.toHaveBeenCalled();
  });

  it("несколько файлов — слияние по ts, время каждой записи разбирается ОДИН раз (не в компараторе)", async () => {
    writeFileSync(join(dir, `server-${DAY}.log`), Array.from({ length: 50 }, (_, i) => line(0, i)).join("\n"));
    writeFileSync(join(dir, `server-${DAY}.4242.log`), Array.from({ length: 50 }, (_, i) => line(1, i)).join("\n"));
    const parse = vi.spyOn(Date, "parse");
    const r = await readDayLogs(dir, [`server-${DAY}.log`, `server-${DAY}.4242.log`], 1, 1_000_000);
    expect(r.entries).toHaveLength(100);
    const ts = r.entries.map((e) => String(e.ts));
    expect(ts).toEqual([...ts].sort()); // хронологически
    expect(parse).toHaveBeenCalledTimes(100);
  });
});
