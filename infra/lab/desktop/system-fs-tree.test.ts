import { describe, expect, it } from "vitest";
import { makeKit } from "./system-test-kit.js";

const keys = (k: ReturnType<typeof makeKit>): string[] => [...k.core.fs.files.keys()].sort();

describe("fs.list", () => {
  it("сортирует без учёта регистра, у каталога size 0, рекурсия — обход в глубину; пути Windows-вида", async () => {
    const k = makeKit();
    k.put("C:/w/b.txt", "bb");
    k.put("C:/w/A.txt", "a");
    k.put("C:/w/sub/z.txt", "zzz");
    const flat = await k.data<{ entries: Array<{ name: string; path: string; type: string; size: number }>; truncated: boolean }>({ kind: "fs.list", path: "C:\\w" });
    expect(flat.entries.map((e) => [e.name, e.type, e.size])).toEqual([["A.txt", "file", 1], ["b.txt", "file", 2], ["sub", "dir", 0]]);
    expect(flat.entries[0]!.path).toBe("C:\\w\\A.txt");
    const deep = await k.data<{ entries: Array<{ name: string }> }>({ kind: "fs.list", path: "C:/w", recursive: true });
    expect(deep.entries.map((e) => e.name)).toEqual(["A.txt", "b.txt", "sub", "z.txt"]);
  });

  it("нет пути → ENOENT scandir; файл → ENOTDIR; кап 5000 → truncated:true", async () => {
    const k = makeKit();
    k.put("C:/w/f.txt", "1");
    expect(await k.err({ kind: "fs.list", path: "C:/нет" })).toBe("ENOENT: no such file or directory, scandir 'C:\\нет'");
    expect(await k.err({ kind: "fs.list", path: "C:/w/f.txt" })).toBe("ENOTDIR: not a directory, scandir 'C:\\w\\f.txt'");
    for (let i = 0; i < 5100; i += 1) k.core.fs.files.set(`C:/many/f${i}.txt`, Buffer.from("x"));
    const r = await k.data<{ entries: unknown[]; truncated: boolean }>({ kind: "fs.list", path: "C:/many" });
    expect(r.entries).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });
});

describe("fs.delete", () => {
  it("файл удаляется НЕОБРАТИМО (эффект permanent), каталог остаётся; нет пути → ENOENT lstat", async () => {
    const k = makeKit();
    k.put("C:/d/a.txt", "1");
    expect(await k.data({ kind: "fs.delete", path: "C:/d/a.txt" })).toEqual({ path: "C:\\d\\a.txt", deleted: true });
    expect(keys(k)).toEqual([]);
    expect(await k.data({ kind: "fs.list", path: "C:/d" })).toMatchObject({ entries: [] }); // каталог пережил последний файл
    expect(k.core.effects.at(-1)).toMatchObject({ kind: "fs.delete", detail: { path: "C:/d/a.txt", type: "file", permanent: true } });
    expect(await k.err({ kind: "fs.delete", path: "C:/d/a.txt" })).toBe("ENOENT: no such file or directory, lstat 'C:\\d\\a.txt'");
  });

  it("каталог без recursive не удаляется (даже пустой), с recursive — целиком, эффект считает записи", async () => {
    const k = makeKit();
    await k.data({ kind: "fs.mkdir", path: "C:/e/empty" });
    k.put("C:/e/tree/a.txt", "1");
    k.put("C:/e/tree/s/b.txt", "2");
    expect(await k.err({ kind: "fs.delete", path: "C:/e/empty" })).toContain("Path is a directory: rm returned EISDIR");
    expect(await k.err({ kind: "fs.delete", path: "C:/e/tree" })).toContain("Path is a directory");
    expect(keys(k)).toHaveLength(2);
    await k.data({ kind: "fs.delete", path: "C:/e/tree", recursive: true });
    expect(keys(k)).toEqual([]);
    expect(k.core.effects.at(-1)?.detail).toMatchObject({ type: "dir", entries: 4, recursive: true });
    expect(await k.err({ kind: "fs.list", path: "C:/e/tree" })).toContain("ENOENT");
  });

  it("рекурсивное удаление каталога с .env / node_modules ВНУТРИ отклоняется целиком, ничего не тронуто", async () => {
    const k = makeKit();
    k.put("C:/proj/src/a.ts", "1");
    k.put("C:/proj/deep/er/.env", "S=1");
    k.put("C:/other/node_modules/x/i.js", "1");
    const m = await k.err({ kind: "fs.delete", path: "C:/proj", recursive: true });
    expect(m).toContain("содержит защищённое («C:\\proj\\deep\\er\\.env»)");
    expect(await k.err({ kind: "fs.delete", path: "C:/other", recursive: true })).toContain("содержит защищённое");
    expect(keys(k)).toHaveLength(3);
    expect(await k.err({ kind: "fs.delete", path: "C:/proj/deep/er/.env" })).toContain("защита самосохранности");
  });
});

describe("fs.move", () => {
  it("переименование файла; поверх существующего файла — перезапись (replaced); каталог переезжает с содержимым", async () => {
    const k = makeKit();
    k.put("C:/m/a.txt", "A");
    k.put("C:/m/b.txt", "B");
    k.put("C:/m/dir/x.txt", "X");
    expect(await k.data({ kind: "fs.move", from: "C:/m/a.txt", to: "C:/m/b.txt" })).toEqual({ from: "C:\\m\\a.txt", to: "C:\\m\\b.txt" });
    expect(k.file("C:/m/b.txt")?.toString()).toBe("A");
    expect(k.core.effects.at(-1)?.detail).toMatchObject({ replaced: true, type: "file" });
    await k.data({ kind: "fs.move", from: "C:/m/dir", to: "C:/m/новая" });
    expect(keys(k)).toEqual(["C:/m/b.txt", "C:/m/новая/x.txt"]);
    expect(k.core.effects.at(-1)?.detail).toMatchObject({ replaced: false, type: "dir" });
  });

  it("перезапись цели с ДРУГИМ регистром имени: остаётся ровно одна запись (регистр — как у нового имени), без дубля", async () => {
    const k = makeKit();
    k.put("C:/m/a.txt", "A");
    k.put("C:/m/B.TXT", "B");
    await k.data({ kind: "fs.move", from: "C:/m/a.txt", to: "C:/m/b.txt" });
    expect(keys(k)).toEqual(["C:/m/b.txt"]);
    expect(k.file("C:/m/b.txt")?.toString()).toBe("A");
  });

  it("ошибки Windows-семантики: поверх каталога EPERM, нет источника/родителя ENOENT, каталог в себя EBUSY/EPERM", async () => {
    const k = makeKit();
    k.put("C:/m/a.txt", "A");
    k.put("C:/m/d1/in/x", "1");
    k.put("C:/m/d2/y", "2");
    expect(await k.err({ kind: "fs.move", from: "C:/m/a.txt", to: "C:/m/d1" })).toBe("EPERM: operation not permitted, rename 'C:\\m\\a.txt' -> 'C:\\m\\d1'");
    expect(await k.err({ kind: "fs.move", from: "C:/m/d1", to: "C:/m/d2" })).toContain("EPERM");
    expect(await k.err({ kind: "fs.move", from: "C:/m/d1", to: "C:/m/d1/newsub" })).toContain("EBUSY");
    expect(await k.err({ kind: "fs.move", from: "C:/m/d1", to: "C:/m/d1/in/deep" })).toContain("EPERM");
    expect(await k.err({ kind: "fs.move", from: "C:/m/нет", to: "C:/m/z" })).toBe("ENOENT: no such file or directory, rename 'C:\\m\\нет' -> 'C:\\m\\z'");
    expect(await k.err({ kind: "fs.move", from: "C:/m/a.txt", to: "C:/нет/z" })).toContain("ENOENT");
    expect(keys(k)).toEqual(["C:/m/a.txt", "C:/m/d1/in/x", "C:/m/d2/y"]);
  });

  it("смена только регистра имени допустима; защищённое ни двигать, ни занимать нельзя", async () => {
    const k = makeKit();
    k.put("C:/m/a.txt", "A");
    await k.data({ kind: "fs.move", from: "C:/m/a.txt", to: "C:/m/A.TXT" });
    expect(keys(k)).toEqual(["C:/m/A.TXT"]);
    k.put("C:/p/.env", "S");
    k.put("C:/q/sub/.env", "S");
    expect(await k.err({ kind: "fs.move", from: "C:/p/.env", to: "C:/p/env.bak" })).toContain("защита самосохранности");
    expect(await k.err({ kind: "fs.move", from: "C:/m/A.TXT", to: "C:/p/.env" })).toContain("защита самосохранности");
    expect(await k.err({ kind: "fs.move", from: "C:/q", to: "C:/q2" })).toContain("содержит защищённое");
  });
});

describe("fs.mkdir", () => {
  it("создаёт цепочку, повтор — не ошибка (created:false); файл на пути → EEXIST / ENOTDIR; недопустимое имя → ENOENT", async () => {
    const k = makeKit();
    expect(await k.data({ kind: "fs.mkdir", path: "C:\\a\\b\\c" })).toEqual({ path: "C:\\a\\b\\c" });
    expect(k.core.effects.at(-1)?.detail).toEqual({ path: "C:/a/b/c", created: true });
    await k.data({ kind: "fs.mkdir", path: "C:/A/B" });
    expect(k.core.effects.at(-1)?.detail).toMatchObject({ created: false, path: "C:/a/b" });
    k.put("C:/a/f.txt", "1");
    expect(await k.err({ kind: "fs.mkdir", path: "C:/a/f.txt" })).toBe("EEXIST: file already exists, mkdir 'C:\\a\\f.txt'");
    expect(await k.err({ kind: "fs.mkdir", path: "C:/a/f.txt/x" })).toBe("ENOTDIR: not a directory, mkdir 'C:\\a\\f.txt'");
    expect(await k.err({ kind: "fs.mkdir", path: "C:/a/что?" })).toContain("ENOENT");
    expect(await k.err({ kind: "fs.mkdir", path: "Z:/x" })).toContain("ENOENT");
  });
});

describe("fs.search", () => {
  it("по имени: файлы и каталоги (kind:dir), без учёта регистра; служебные каталоги не обходит, но говорит об этом", async () => {
    const k = makeKit();
    k.put("C:/s/Report.docx", "x");
    k.put("C:/s/reports/old.txt", "x");
    k.put("C:/s/node_modules/report/index.js", "x");
    const r = await k.data<{ matches: Array<{ path: string; kind?: string }>; ignoredDirs: number; exhausted: boolean; note: string }>({ kind: "fs.search", root: "C:/s", query: "REPORT" });
    expect(r.matches).toEqual([{ path: "C:\\s\\Report.docx" }, { path: "C:\\s\\reports", kind: "dir" }]);
    expect(r.ignoredDirs).toBe(1);
    expect(r.note).toContain("node_modules");
    expect(r.exhausted).toBe(true);
    const all = await k.data<{ matches: Array<{ path: string }> }>({ kind: "fs.search", root: "C:/s", query: "report", ignore: [] });
    expect(all.matches.some((m) => m.path.endsWith("node_modules\\report\\index.js") || m.path.endsWith("node_modules\\report"))).toBe(true);
  });

  it("по содержимому: номер строки с 1, превью, cp1251 находится и помечается; секретные файлы пропускаются", async () => {
    const k = makeKit();
    k.put("C:/s/a.txt", "первая\nвторая ИГЛА тут\nтретья");
    k.put("C:/s/w.txt", Buffer.from([0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xe8, 0xe3, 0xeb, 0xe0])); // «привет игла» в cp1251
    k.put("C:/s/.env", "игла=секрет");
    const r = await k.data<{ matches: Array<{ path: string; line?: number; preview?: string }>; recodedFiles: number; note: string }>({ kind: "fs.search", root: "C:/s", query: "игла", inContent: true });
    expect(r.matches).toEqual([{ path: "C:\\s\\a.txt", line: 2, preview: "вторая ИГЛА тут" }, { path: "C:\\s\\w.txt", line: 1, preview: "привет игла" }]);
    expect(r.recodedFiles).toBe(1);
    expect(r.note).toContain("cp1251");
  });

  it("maxResults обрывает обход честно: truncated, stopReason, exhausted:false; корень: нет / файл / секрет — ошибка, а не «пусто»", async () => {
    const k = makeKit();
    for (let i = 0; i < 5; i += 1) k.put(`C:/s/hit${i}.txt`, "x");
    const r = await k.data<{ matches: unknown[]; truncated: boolean; stopReason: string; exhausted: boolean; note: string }>({ kind: "fs.search", root: "C:/s", query: "hit", maxResults: 2 });
    expect(r).toMatchObject({ truncated: true, stopReason: "max_results", exhausted: false });
    expect(r.matches).toHaveLength(2);
    expect(r.note).toContain("совпадений может быть больше");
    expect(await k.err({ kind: "fs.search", root: "C:/нет", query: "x" })).toBe("fs.search: корень «C:\\нет» не существует.");
    expect(await k.err({ kind: "fs.search", root: "C:/s/hit0.txt", query: "x" })).toContain("не каталог (это файл)");
    k.put("C:/Users/lab/.ssh/id_rsa", "K");
    expect(await k.err({ kind: "fs.search", root: "C:/Users/lab/.ssh", query: "id" })).toContain("защита секретов");
  });
});
