import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile, editFile, writeFile } from "./fs.js";
import { fileUndo, withFileUndo } from "./fs-undo.js";

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(join(tmpdir(), "jarvis-undo-")); });
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });
async function existing(bytes: Buffer | string = "old") {
  const path = join(root, "file.txt");
  await fsp.writeFile(path, bytes);
  return path;
}
async function entries() {
  const result = await fileUndo("list");
  return (result.entries ?? []).filter((entry) => entry.path.startsWith(root));
}

describe("bounded file undo — actual filesystem", () => {
  it("restores exact raw bytes, including BOM/UTF16/NUL, after overwrite", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Привет\r\n\0", "utf16le")]);
    const path = await existing(bytes);
    const written = await writeFile(path, "replacement");
    expect(written.undoAvailable).toBe(true);
    const result = await fileUndo("restore", written.undoId);
    expect(result).toMatchObject({ restored: true, verified: true, path, bytes: bytes.length });
    expect(await fsp.readFile(path)).toEqual(bytes);
  });

  it("edit and append roll back newest-first, preserving CRLF and unicode", async () => {
    const bytes = Buffer.from("\ufeffпервая\r\nвторая\r\n");
    const path = await existing(bytes);
    const edit = await editFile(path, "первая", "новая");
    const append = await appendFile(path, "третья\r\n");
    expect((await entries()).map((e) => e.id)).toEqual([append.undoId, edit.undoId]);
    await expect(fileUndo("restore", edit.undoId)).rejects.toThrow(/изменён/);
    await fileUndo("restore", append.undoId);
    await fileUndo("restore", edit.undoId);
    expect(await fsp.readFile(path)).toEqual(bytes);
  });

  it("unknown, missing and already-used IDs never select another entry", async () => {
    const path = await existing();
    const first = await writeFile(path, "first");
    const second = await writeFile(path, "second");
    await expect(fileUndo("restore")).rejects.toThrow(/точный id/);
    await expect(fileUndo("restore", "unknown")).rejects.toThrow(/неизвестен/);
    await fileUndo("restore", second.undoId);
    await expect(fileUndo("restore", second.undoId)).rejects.toThrow(/уже восстановлен/);
    expect(await fsp.readFile(path, "utf8")).toBe("first");
    expect((await entries()).map((e) => e.id)).toEqual([first.undoId]);
  });

  it("refuses external edits and leaves both bytes and undo entry intact", async () => {
    const path = await existing();
    const result = await writeFile(path, "jarvis");
    await fsp.writeFile(path, "owner edits");
    await expect(fileUndo("restore", result.undoId)).rejects.toThrow(/изменён/);
    expect(await fsp.readFile(path, "utf8")).toBe("owner edits");
    expect((await entries())[0]?.id).toBe(result.undoId);
  });

  it("refuses replaced file even when its bytes equal the expected post-image", async () => {
    const path = await existing();
    const result = await writeFile(path, "same bytes");
    await fsp.rename(path, join(root, "original.txt"));
    await fsp.writeFile(path, "same bytes");
    await expect(fileUndo("restore", result.undoId)).rejects.toThrow(/подменён/);
    expect(await fsp.readFile(path, "utf8")).toBe("same bytes");
  });

  it("refuses changed parent via junction/symlink without touching its target", async () => {
    const dir = join(root, "dir");
    const target = join(root, "target");
    await fsp.mkdir(dir); await fsp.mkdir(target);
    const path = join(dir, "a.txt");
    await fsp.writeFile(path, "before");
    const result = await writeFile(path, "after");
    await fsp.rename(dir, join(root, "original-dir"));
    await fsp.writeFile(join(target, "a.txt"), "after");
    await fsp.symlink(target, dir, process.platform === "win32" ? "junction" : "dir");
    await expect(fileUndo("restore", result.undoId)).rejects.toThrow(/ссылка|junction/);
    expect(await fsp.readFile(join(target, "a.txt"), "utf8")).toBe("after");
  });

  it("does not retain failed mutations or unchanged writes", async () => {
    const path = await existing("same");
    await expect(editFile(path, "absent", "x")).rejects.toThrow(/не найден/);
    const same = await writeFile(path, "same");
    expect(same).toMatchObject({ undoAvailable: false });
    await expect(withFileUndo(path, "fs.write", async () => { throw new Error("disk failed"); })).rejects.toThrow("disk failed");
    expect(await entries()).toEqual([]);
  });

  it("reports unsupported creation and big snapshots, with no undo ID", async () => {
    const fresh = await writeFile(join(root, "new.txt"), "created");
    expect(fresh).toMatchObject({ undoAvailable: false, note: expect.stringMatching(/создания/) });
    expect(fresh.undoId).toBeUndefined();
    const path = await existing(Buffer.alloc(1024 * 1024 + 1));
    const large = await writeFile(path, "small now");
    expect(large).toMatchObject({ undoAvailable: false, note: expect.stringMatching(/1 MiB/) });
    expect(await entries()).toEqual([]);
  });

  it("accepts exact 1 MiB and exposes only metadata, not old/new bytes or hashes", async () => {
    const secret = "private-old-contents";
    const bytes = Buffer.alloc(1024 * 1024, 42); bytes.write(secret);
    const path = await existing(bytes);
    const result = await writeFile(path, "private-new-contents");
    const listed = await fileUndo("list");
    expect(result.undoAvailable).toBe(true);
    expect(JSON.stringify([result, listed])).not.toMatch(/private-old-contents|private-new-contents|"hash"|"type":"Buffer"/);
    await fileUndo("restore", result.undoId);
    expect(await fsp.readFile(path)).toEqual(bytes);
  });

  it("keeps at most 10 entries and never restores an evicted ID", async () => {
    const path = await existing();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push((await writeFile(path, `value ${i}`)).undoId!);
    const rows = await entries();
    expect(rows).toHaveLength(10);
    expect(rows.map((e) => e.id)).toEqual(ids.slice(1).reverse());
    await expect(fileUndo("restore", ids[0])).rejects.toThrow(/истёк/);
    expect(await fsp.readFile(path, "utf8")).toBe("value 10");
  });

  it("serializes concurrent appends and restores each exact intermediate image", async () => {
    const path = await existing("start:");
    const [a, b, c] = await Promise.all([appendFile(path, "A"), appendFile(path, "B"), appendFile(path, "C")]);
    expect(await fsp.readFile(path, "utf8")).toBe("start:ABC");
    for (const [id, content] of [[c.undoId, "start:AB"], [b.undoId, "start:A"], [a.undoId, "start:"]]) {
      await fileUndo("restore", id);
      expect(await fsp.readFile(path, "utf8")).toBe(content);
    }
  });
});
