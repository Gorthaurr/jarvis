import { describe, expect, it } from "vitest";
import { createFakeDesktop, supportedKinds } from "./index.js";
import { createDesktopCore } from "./core.js";
import { expandPath } from "./vfs.js";

const M = (n: number) => ({ commandId: `c${n}`, timeoutMs: 1000 });

describe("системная половина FakeDesktop через createFakeDesktop", () => {
  it("регистрирует ровно свои виды команд (для матрицы покрытия)", () => {
    const mine = ["audio.sessions", "audio.set", "fs.append", "fs.delete", "fs.edit", "fs.list", "fs.mkdir", "fs.move", "fs.read", "fs.search", "fs.view", "fs.write", "system.clipboard", "system.layout", "system.lock", "system.media", "system.power", "system.volume"];
    const all = supportedKinds();
    for (const kind of mine) expect(all, kind).toContain(kind);
  });

  it("факт виден в snapshot(): файл, буфер, громкость, блокировка; ошибка — runtime с текстом Node БЕЗ приставки диспетчера", async () => {
    const d = createFakeDesktop({ files: { "Desktop/n.txt": "старое" } });
    await d.handle({ kind: "fs.edit", path: "Desktop/n.txt", old: "старое", new: "новое" }, M(1));
    await d.handle({ kind: "system.clipboard", op: "write", text: "буфер" }, M(2));
    await d.handle({ kind: "system.volume", op: "set", level: 15 }, M(3));
    await d.handle({ kind: "system.lock" }, M(4));
    const s = d.snapshot();
    expect(s.files["C:/Users/lab/Desktop/n.txt"]).toBe("новое");
    expect(s).toMatchObject({ clipboard: "буфер", volume: 15, locked: true });
    expect(s.effects.map((e) => e.kind)).toEqual(["fs.edit", "clipboard.write", "system.volume", "system.lock"]);
    const bad = await d.handle({ kind: "fs.read", path: "нет.txt" }, M(5));
    expect(bad).toMatchObject({ commandId: "c5", ok: false, error: { code: "runtime", message: "ENOENT: no such file or directory, stat 'C:\\Users\\lab\\нет.txt'" } });
    d.reset();
    expect(d.snapshot()).toMatchObject({ files: {}, clipboard: "", locked: false, effects: [] });
  });

  it("сид-файлы читаются клиентским путём с относительным адресом; пути с .. не выходят за корень диска", async () => {
    const d = createFakeDesktop({ files: { "a/b.txt": "x" } });
    const r = await d.handle({ kind: "fs.read", path: "~\\a\\..\\a\\b.txt" }, M(1));
    expect(r.data).toMatchObject({ path: "C:\\Users\\lab\\a\\b.txt", content: "x" });
    const core = createDesktopCore();
    expect(expandPath(core, "C:\\..\\..\\Windows")).toBe("C:/Windows");
    expect(expandPath(core, "/tmp/x/")).toBe("C:/tmp/x");
    expect(expandPath(core, "d:/Data")).toBe("D:/Data");
    expect(expandPath(core, "")).toBe("C:/Users/lab");
  });
});
