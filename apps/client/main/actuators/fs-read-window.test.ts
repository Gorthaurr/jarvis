/**
 * fs.read ОКНОМ строк (причина №6 USER_SCENARIOS_2026-09-02): offset+lines / tail, честные totalLines/range/note,
 * огромный файл — только хвост (tail) или честная ошибка (offset). Чистая часть и реальная ФС.
 */
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyLineWindow, splitLines } from "./fs-read-window.js";
import { readFile, writeFile } from "./fs.js";

let root: string;
beforeAll(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "jarvis-fswin-"));
});
afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

const lines = (n: number): string => `${Array.from({ length: n }, (_, i) => `строка ${i + 1}`).join("\n")}\n`;

describe("applyLineWindow (чистая)", () => {
  it("offset+lines → нужный диапазон, note с ГОТОВЫМ offset следующего куска", () => {
    const w = applyLineWindow(lines(10), { offset: 3, lines: 4 });
    expect(w.content).toBe("строка 3\nстрока 4\nстрока 5\nстрока 6");
    expect(w).toMatchObject({ from: 3, to: 6, totalLines: 10, complete: false });
    expect(w.note).toContain("offset=7");
  });

  it("tail → последние N строк, complete=false, note «выше ещё … (это хвост файла)»", () => {
    const w = applyLineWindow(lines(10), { tail: 3 });
    expect(w.content).toBe("строка 8\nстрока 9\nстрока 10");
    expect(w).toMatchObject({ from: 8, to: 10, totalLines: 10, complete: false });
    expect(w.note).toContain("выше ещё 7");
    expect(w.note).not.toContain("следующий кусок"); // хвост — дальше ничего нет
  });

  it("окно за концом файла → пустой content и честная note, не исключение и не «файл пуст»", () => {
    const w = applyLineWindow(lines(10), { offset: 50, lines: 5 });
    expect(w.content).toBe("");
    expect(w.totalLines).toBe(10);
    expect(w.note).toContain("всего 10");
    expect(w.complete).toBe(false);
  });

  it("окно, покрывшее весь файл → complete=true, без note; tail больше файла — тоже целиком", () => {
    expect(applyLineWindow(lines(5), { offset: 1, lines: 100 })).toMatchObject({ complete: true, from: 1, to: 5 });
    expect(applyLineWindow(lines(5), { offset: 1, lines: 100 }).note).toBeUndefined();
    expect(applyLineWindow(lines(5), { tail: 100 })).toMatchObject({ complete: true, from: 1, to: 5 });
  });

  it("хвостовой перенос не считается строкой; CRLF режется; пустой текст — 0 строк", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(applyLineWindow("", { tail: 3 })).toMatchObject({ totalLines: 0, complete: true, content: "" });
  });
});

describe("fs.read окном (реальная ФС)", () => {
  it("offset/lines: content — только окно; totalLines/range/truncated честные; note ведёт к следующему куску", async () => {
    const p = join(root, "big.log");
    await writeFile(p, lines(1000));
    const r = await readFile(p, undefined, { offset: 501, lines: 100 });
    expect(r.content.startsWith("строка 501\n")).toBe(true);
    expect(r.content.endsWith("строка 600")).toBe(true);
    expect(r.range).toEqual({ from: 501, to: 600 });
    expect(r.totalLines).toBe(1000);
    expect(r.truncated).toBe(true); // показан не весь файл
    expect(r.note).toContain("offset=601");
  });

  it("tail: последние строки файла", async () => {
    const p = join(root, "tail.log");
    await writeFile(p, lines(50));
    const r = await readFile(p, undefined, { tail: 5 });
    expect(r.content).toBe("строка 46\nстрока 47\nстрока 48\nстрока 49\nстрока 50");
    expect(r.range).toEqual({ from: 46, to: 50 });
    expect(r.totalLines).toBe(50);
  });

  it("без окна — прежнее чтение целиком, плюс totalLines", async () => {
    const p = join(root, "whole.txt");
    await writeFile(p, lines(7));
    const r = await readFile(p);
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(7);
    expect(r.range).toBeUndefined();
  });

  it("усечение по maxBytes: totalLines НЕ выдумывается, note велит читать окном", async () => {
    const p = join(root, "cut.txt");
    await writeFile(p, lines(100));
    const r = await readFile(p, 50);
    expect(r.truncated).toBe(true);
    expect(r.totalLines).toBeUndefined();
    expect(r.note).toMatch(/окном/iu);
  });

  it("огромный файл (порог теста): tail читает ТОЛЬКО хвост и говорит об этом; offset → честная ошибка с каналом", async () => {
    const p = join(root, "huge.log");
    await writeFile(p, lines(200));
    const r = await readFile(p, undefined, { tail: 3 }, { wholeFileCap: 100, tailChunkBytes: 300 });
    expect(r.content.split("\n")).toHaveLength(3);
    expect(r.content.endsWith("строка 200")).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.note).toContain("только хвост");
    expect(r.note).toContain("от начала файла не считаются");
    expect(r.totalLines).toBeUndefined(); // счёт внутри куска — не выдаём за счёт файла
    await expect(readFile(p, undefined, { offset: 5, lines: 3 }, { wholeFileCap: 100 })).rejects.toThrow(/tail/u);
  });

  it("ревью HIGH: хвост UTF-8 с кириллицей, срез посреди символа → НЕ моджибейк и НЕ ложная cp1251, первая строка полная", async () => {
    const p = join(root, "cyr.log");
    const text = `${Array.from({ length: 300 }, (_, i) => `кириллица ${i + 1}`).join("\n")}\n`;
    const bytes = Buffer.from(text, "utf8");
    await fsp.writeFile(p, bytes);
    // Подбираем размер куска так, чтобы срез пришёлся на continuation-байт (0b10xxxxxx) — ровно случай ревью.
    let chunk = 300;
    while ((bytes[bytes.length - chunk]! & 0xc0) !== 0x80) chunk += 1;
    const r = await readFile(p, undefined, { tail: 5 }, { wholeFileCap: 100, tailChunkBytes: chunk });
    expect(r.encoding).toBe("utf8");
    expect(r.content).not.toContain("�");
    expect(r.content.split("\n")).toHaveLength(5);
    expect(r.content.endsWith("кириллица 300")).toBe(true);
    expect(r.content.startsWith("кириллица ")).toBe(true);
    expect(r.note).not.toContain("cp1251");
  });

  it("ревью MED: хвост UTF-16LE (BOM только в голове) — кодировка по голове, не «бинарник», нечётный срез выровнен", async () => {
    const p = join(root, "u16.log");
    const text = `${Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    await fsp.writeFile(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    const r = await readFile(p, undefined, { tail: 4 }, { wholeFileCap: 100, tailChunkBytes: 301 });
    expect(r.encoding).toBe("utf16le");
    expect(r.content).toBe("line 197\nline 198\nline 199\nline 200");
  });

  it("ревью LOW: в хвосте нет ни одной полной строки → пустой content с ПРИЧИНОЙ, не «0 строк»", async () => {
    const p = join(root, "oneline.json");
    await fsp.writeFile(p, `{"a":"${"x".repeat(2000)}"}`);
    const r = await readFile(p, undefined, { tail: 3 }, { wholeFileCap: 100, tailChunkBytes: 300 });
    expect(r.content).toBe("");
    expect(r.truncated).toBe(true);
    expect(r.note).toContain("ни одной полной строки");
  });

  it("lines без offset на огромном файле → начало файла куском, range от 1, note «только начало»", async () => {
    const p = join(root, "head.log");
    await writeFile(p, lines(200));
    const r = await readFile(p, undefined, { lines: 3 }, { wholeFileCap: 100, tailChunkBytes: 300 });
    expect(r.content).toBe("строка 1\nстрока 2\nстрока 3");
    expect(r.range).toEqual({ from: 1, to: 3 });
    expect(r.totalLines).toBeUndefined();
    expect(r.note).toContain("только начало");
  });

  it("ревью MED: плоское чтение огромного файла поднимает только голову maxBytes, truncated от реального размера", async () => {
    const p = join(root, "flat-huge.log");
    await writeFile(p, lines(200));
    const bytes = await fsp.readFile(p);
    const size = bytes.length;
    // Лимит подбираем так, чтобы срез пришёлся ПОСРЕДИ символа (continuation-байт) — иначе тест не проверяет обрубок.
    let maxBytes = 40;
    while ((bytes[maxBytes]! & 0xc0) !== 0x80) maxBytes += 1;
    const r = await readFile(p, maxBytes, undefined, { wholeFileCap: 100 });
    expect(r.bytes).toBe(size);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(r.note).toContain(`из ${size}`);
    // Срез головы посреди символа не должен включать ложную cp1251 (тот же класс, что HIGH по хвосту).
    expect(r.encoding).toBe("utf8");
    expect(r.content).not.toContain("�");
    expect(r.content.startsWith("строка 1")).toBe(true);
  });

  it("ревью MED: content — ПОСЛЕДНИЙ ключ результата (серверный кап режет JSON с хвоста, мета обязана выжить)", async () => {
    const p = join(root, "order.txt");
    await writeFile(p, lines(5));
    expect(Object.keys(await readFile(p)).at(-1)).toBe("content");
    expect(Object.keys(await readFile(p, undefined, { tail: 2 })).at(-1)).toBe("content");
    expect(Object.keys(await readFile(p, 3)).at(-1)).toBe("content");
  });

  it("tail и offset вместе → ошибка; нецелое/нулевое значение → ошибка", async () => {
    const p = join(root, "v.txt");
    await writeFile(p, lines(3));
    await expect(readFile(p, undefined, { tail: 2, offset: 1 })).rejects.toThrow(/tail и offset/u);
    await expect(readFile(p, undefined, { offset: 0 })).rejects.toThrow(/≥ 1/u);
  });

  it("бинарник окном → та же честная ошибка, что и целиком (не «пустое окно»)", async () => {
    const p = join(root, "pic.png");
    await fsp.writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    await expect(readFile(p, undefined, { tail: 5 })).rejects.toThrow(/бинарный/u);
  });
});
