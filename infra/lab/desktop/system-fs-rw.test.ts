import { describe, expect, it } from "vitest";
import { makeKit } from "./system-test-kit.js";
import { readText } from "./system-fs-read.js";

/** cp1251 для кириллицы (А–я = C0–FF, Ё/ё отдельно): в Node нет iconv, а файл «Блокнота» владельца бывает именно таким. */
const cp1251 = (s: string): Buffer =>
  Buffer.from([...s].map((ch) => { const c = ch.charCodeAt(0); return c >= 0x410 && c <= 0x44f ? c - 0x350 : c === 0x401 ? 0xa8 : c === 0x451 ? 0xb8 : c; }));
const utf16bom = (s: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8), Buffer.from("IEND")]);

describe("fs.write / fs.read", () => {
  it("создаёт файл, путь в ответе — Windows-вида, bytes — в байтах utf8, повтор = created:false, эффект пишется", async () => {
    const k = makeKit();
    const r1 = await k.data({ kind: "fs.write", path: "Desktop\\заметка.txt", content: "Привет" });
    expect(r1).toEqual({ path: "C:\\Users\\lab\\Desktop\\заметка.txt", bytes: 12, created: true });
    const r2 = await k.data({ kind: "fs.write", path: "~/Desktop/заметка.txt", content: "x" });
    expect(r2).toMatchObject({ bytes: 1, created: false });
    expect(k.core.effects.filter((e) => e.kind === "fs.write").map((e) => e.detail)).toEqual([
      { path: "C:/Users/lab/Desktop/заметка.txt", bytes: 12, created: true },
      { path: "C:/Users/lab/Desktop/заметка.txt", bytes: 1, created: false },
    ]);
    expect(k.file("C:/Users/lab/Desktop/заметка.txt")?.toString()).toBe("x");
  });

  it("нет каталога → ENOENT open, а createDirs создаёт цепочку; запись на каталог → EISDIR; ошибки — runtime", async () => {
    const k = makeKit();
    expect(await k.err({ kind: "fs.write", path: "C:\\proj\\a\\b.txt", content: "1" })).toBe("ENOENT: no such file or directory, open 'C:\\proj\\a\\b.txt'");
    expect(k.file("C:/proj/a/b.txt")).toBeUndefined();
    await k.data({ kind: "fs.write", path: "C:\\proj\\a\\b.txt", content: "1", createDirs: true });
    expect(k.file("C:/proj/a/b.txt")?.toString()).toBe("1");
    expect(await k.err({ kind: "fs.write", path: "C:\\proj\\a", content: "1" })).toMatch(/^EISDIR: illegal operation on a directory, open/u);
  });

  it("регистр пути не важен (NTFS): запись в A.TXT перезаписывает a.txt, имя остаётся прежним", async () => {
    const k = makeKit();
    await k.data({ kind: "fs.write", path: "C:\\d\\a.txt", content: "1", createDirs: true });
    const r = await k.data<{ created: boolean }>({ kind: "fs.write", path: "C:\\D\\A.TXT", content: "22" });
    expect(r.created).toBe(false);
    expect([...k.core.fs.files.keys()]).toEqual(["C:/d/a.txt"]);
    expect((await k.data<{ content: string }>({ kind: "fs.read", path: "c:/d/A.txt" })).content).toBe("22");
  });

  it("пустой файл: bytes 0, totalLines 0, без note; content — последним ключом ответа", async () => {
    const k = makeKit();
    k.put("C:/e/empty.txt", "");
    k.put("C:/e/two.txt", "a\r\nb\r\n");
    expect(await k.data({ kind: "fs.read", path: "C:\\e\\empty.txt" })).toEqual({ path: "C:\\e\\empty.txt", bytes: 0, truncated: false, encoding: "utf8", totalLines: 0, content: "" });
    const two = await k.data<Record<string, unknown>>({ kind: "fs.read", path: "C:\\e\\two.txt" });
    expect(two).toMatchObject({ totalLines: 2, truncated: false, encoding: "utf8" });
    expect(Object.keys(two).at(-1)).toBe("content");
  });

  it("кодировки: BOM срезается, UTF-16 декодируется, cp1251 читается по эвристике с note", async () => {
    const k = makeKit();
    k.put("C:/e/bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("привет", "utf8")]));
    k.put("C:/e/u16.txt", utf16bom("Строка"));
    k.put("C:/e/win.txt", cp1251("Привет, мир! Это тест кодировки."));
    expect(await k.data({ kind: "fs.read", path: "C:/e/bom.txt" })).toMatchObject({ encoding: "utf8-bom", content: "привет" });
    expect(await k.data({ kind: "fs.read", path: "C:/e/u16.txt" })).toMatchObject({ encoding: "utf16le", content: "Строка" });
    const win = await k.data<{ encoding: string; content: string; note: string }>({ kind: "fs.read", path: "C:/e/win.txt" });
    expect(win.encoding).toBe("cp1251");
    expect(win.content).toBe("Привет, мир! Это тест кодировки.");
    expect(win.note).toMatch(/cp1251/u);
  });

  it("бинарник (PNG) текстом не читается; несуществующий путь → ENOENT stat", async () => {
    const k = makeKit();
    k.put("C:/e/pic.png", PNG);
    expect(await k.err({ kind: "fs.read", path: "C:\\e\\pic.png" })).toMatch(/^«C:\\e\\pic\.png» — бинарный файл \(PNG-изображение\).*file_view/u);
    expect(await k.err({ kind: "fs.read", path: "C:\\e\\нет.txt" })).toBe("ENOENT: no such file or directory, stat 'C:\\e\\нет.txt'");
    expect(await k.err({ kind: "fs.read", path: "C:\\e" })).toBe("EISDIR: illegal operation on a directory, read");
  });

  it("секреты не читаются: .env / id_rsa → отказ с путём в Windows-виде (рельсы клиента)", async () => {
    const k = makeKit();
    k.put("C:/Users/lab/proj/.env", "TOKEN=abc");
    k.put("C:/Users/lab/.ssh/id_rsa", "KEY");
    const m = await k.err({ kind: "fs.read", path: "C:\\Users\\lab\\proj\\.env" });
    expect(m).toContain("защита секретов (§0)");
    expect(m).toContain("«C:\\Users\\lab\\proj\\.env»");
    expect(m).not.toContain("abc");
    expect(await k.err({ kind: "fs.read", path: "~/.ssh/id_rsa" })).toContain("защита секретов");
  });

  it("усечение по maxBytes: truncated + note, totalLines не выдумывается; окно строк с готовым offset", async () => {
    const k = makeKit();
    k.put("C:/e/log.txt", Array.from({ length: 1000 }, (_, i) => `строка ${i + 1}`).join("\n"));
    const cut = await k.data<Record<string, unknown>>({ kind: "fs.read", path: "C:/e/log.txt", maxBytes: 50 });
    expect(cut.truncated).toBe(true);
    expect(cut).not.toHaveProperty("totalLines");
    expect(String(cut.note)).toMatch(/показаны первые 50 байт из \d+/u);
    const win = await k.data<{ content: string; note: string; range: { from: number; to: number }; totalLines: number }>({ kind: "fs.read", path: "C:/e/log.txt", offset: 10, lines: 3 });
    expect(win.content).toBe("строка 10\nстрока 11\nстрока 12");
    expect(win).toMatchObject({ range: { from: 10, to: 12 }, totalLines: 1000 });
    expect(win.note).toContain("следующий кусок: offset=13");
    const tail = await k.data<{ content: string }>({ kind: "fs.read", path: "C:/e/log.txt", tail: 2 });
    expect(tail.content).toBe("строка 999\nстрока 1000");
    expect(await k.err({ kind: "fs.read", path: "C:/e/log.txt", tail: 2, offset: 3 })).toContain("tail и offset вместе");
  });

  it("огромный файл (порог понижен): tail читает только хвост, offset — честный отказ", async () => {
    const k = makeKit();
    k.put("C:/e/big.log", Array.from({ length: 200 }, (_, i) => `запись-${i + 1}`).join("\n"));
    const t = readText(k.core, "C:/e/big.log", undefined, { tail: 2 }, { wholeFileCap: 100, tailChunkBytes: 60 });
    expect(t.content).toBe("запись-199\nзапись-200");
    expect(t.truncated).toBe(true);
    expect(t.note).toContain("прочитан только хвост");
    expect(() => readText(k.core, "C:/e/big.log", undefined, { offset: 5 }, { wholeFileCap: 100 })).toThrow(/окно по offset на таком файле не читаю/u);
  });
});

describe("fs.edit / fs.append", () => {
  it("правит по уникальному вхождению; 0 и >1 без replaceAll — ошибки БЕЗ изменения файла; $-паттерны буквальны", async () => {
    const k = makeKit();
    k.put("C:/p/a.txt", "aa bb aa $& cc");
    expect(await k.err({ kind: "fs.edit", path: "C:/p/a.txt", old: "aa", new: "X" })).toContain("встречается 2 раз");
    expect(await k.err({ kind: "fs.edit", path: "C:/p/a.txt", old: "zz", new: "X" })).toContain("фрагмент не найден");
    expect(k.file("C:/p/a.txt")?.toString()).toBe("aa bb aa $& cc");
    expect(await k.data({ kind: "fs.edit", path: "C:/p/a.txt", old: "bb", new: "$1" })).toEqual({ path: "C:\\p\\a.txt", replacements: 1, bytes: 14 });
    expect(await k.data({ kind: "fs.edit", path: "C:/p/a.txt", old: "aa", new: "Z", replaceAll: true })).toMatchObject({ replacements: 2 });
    expect(k.file("C:/p/a.txt")?.toString()).toBe("Z $1 Z $& cc");
  });

  it("old==new и пустой old отклоняются ДО чтения файла (даже у несуществующего)", async () => {
    const k = makeKit();
    expect(await k.err({ kind: "fs.edit", path: "C:/нет.txt", old: "a", new: "a" })).toContain("old и new одинаковы");
    expect(await k.err({ kind: "fs.edit", path: "C:/нет.txt", old: "", new: "a" })).toContain("old пустой");
    expect(await k.err({ kind: "fs.edit", path: "C:/нет.txt", old: "a", new: "b" })).toBe("ENOENT: no such file or directory, open 'C:\\нет.txt'");
  });

  it("ИЗВЕСТНЫЙ ДЕФЕКТ клиента воспроизведён: правка cp1251-файла портит кириллицу (utf8 без sniff), UTF-16 — «не найден»", async () => {
    const k = makeKit();
    k.put("C:/p/win.txt", cp1251("Привет, мир! version=1"));
    await k.data({ kind: "fs.edit", path: "C:/p/win.txt", old: "version=1", new: "version=2" });
    const after = k.file("C:/p/win.txt")!;
    expect(after.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(true); // U+FFFD вместо «Привет»
    expect(after.toString("utf8")).toContain("version=2");
    k.put("C:/p/u16.txt", utf16bom("hello"));
    expect(await k.err({ kind: "fs.edit", path: "C:/p/u16.txt", old: "hello", new: "bye" })).toContain("фрагмент не найден");
  });

  it("BOM при правке сохраняется как символ; защищённые пути (.env, node_modules) править нельзя", async () => {
    const k = makeKit();
    k.put("C:/p/b.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one two")]));
    await k.data({ kind: "fs.edit", path: "C:/p/b.txt", old: "two", new: "2" });
    expect([...k.file("C:/p/b.txt")!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    k.put("C:/p/.env", "A=1");
    k.put("C:/p/node_modules/x/index.js", "1");
    expect(await k.err({ kind: "fs.edit", path: "C:/p/.env", old: "A", new: "B" })).toContain("защита самосохранности");
    expect(await k.err({ kind: "fs.write", path: "C:/p/node_modules/x/index.js", content: "2" })).toContain("защита самосохранности");
    expect(k.file("C:/p/.env")?.toString()).toBe("A=1");
  });

  it("append создаёт файл, возвращает число ДОПИСАННЫХ байт; в UTF-16 дописывает utf8 (дефект клиента); без каталога — ENOENT", async () => {
    const k = makeKit();
    expect(await k.data({ kind: "fs.append", path: "C:/Users/lab/log.txt", content: "ab" })).toEqual({ path: "C:\\Users\\lab\\log.txt", bytes: 2 });
    expect(await k.data({ kind: "fs.append", path: "C:/Users/lab/log.txt", content: "Ж" })).toMatchObject({ bytes: 2 });
    expect(k.file("C:/Users/lab/log.txt")?.toString()).toBe("abЖ");
    expect(k.core.effects.at(-1)?.detail).toMatchObject({ bytes: 2, totalBytes: 4 });
    k.put("C:/Users/lab/u16.txt", utf16bom("hi"));
    await k.data({ kind: "fs.append", path: "C:/Users/lab/u16.txt", content: "yo" });
    expect(k.file("C:/Users/lab/u16.txt")!.length).toBe(6 + 2);
    expect(await k.err({ kind: "fs.append", path: "C:/нет/x.txt", content: "1" })).toContain("ENOENT");
    expect(await k.err({ kind: "fs.append", path: "C:/Users/lab/Desktop", content: "1" })).toBe("EISDIR: illegal operation on a directory, write");
  });
});

describe("пути: переменные окружения и ~", () => {
  it("%USERPROFILE%/%APPDATA%/~ раскрываются в виртуальный ПК; чужая %VAR% остаётся литералом (секрет окружения не утекает)", async () => {
    const k = makeKit();
    await k.data({ kind: "fs.write", path: "%USERPROFILE%\\Desktop\\a.txt", content: "1" });
    await k.data({ kind: "fs.write", path: "%APPDATA%\\app\\cfg.json", content: "2", createDirs: true });
    expect([...k.core.fs.files.keys()].sort()).toEqual(["C:/Users/lab/AppData/Roaming/app/cfg.json", "C:/Users/lab/Desktop/a.txt"]);
    expect(await k.err({ kind: "fs.read", path: "%OBS_WEBSOCKET_PASSWORD%\\x" })).toContain("%OBS_WEBSOCKET_PASSWORD%");
  });
});
