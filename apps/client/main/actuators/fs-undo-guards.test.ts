import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, deleteEntry } from "./fs.js";
import { fileUndo, withFileUndo } from "./fs-undo.js";
import { fileHash } from "./fs-undo-file.js";

let root: string;
beforeEach(async () => { root = await fsp.mkdtemp(join(tmpdir(), "jarvis-undo-guards-")); });
afterEach(async () => { vi.restoreAllMocks(); await fsp.rm(root, { recursive: true, force: true }); });
async function existing() { const path = join(root, "a.txt"); await fsp.writeFile(path, "old"); return path; }
async function entries() { return ((await fileUndo("list")).entries ?? []).filter((e) => e.path.startsWith(root)); }

it("does not register a foreign post-image as Jarvis's own successful write", async () => {
  const path = await existing();
  const result = await withFileUndo(path, "fs.write", async () => {
    await fsp.writeFile(path, "jarvis");
    await fsp.writeFile(path, "external writer");
    return { result: { path }, expectedHash: fileHash("jarvis") };
  });
  expect(result).toMatchObject({ undoAvailable: false, note: expect.stringMatching(/сторонняя правка/) });
  expect(await entries()).toEqual([]);
  expect(await fsp.readFile(path, "utf8")).toBe("external writer");
});

it("restore and deletion wait for an in-flight mutation, never racing its journal", async () => {
  const path = await existing();
  const first = await writeFile(path, "one");
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const second = withFileUndo(path, "fs.write", async () => {
    entered(); await barrier;
    await fsp.writeFile(path, "two");
    return { result: { path }, expectedHash: fileHash("two") };
  });
  await started;
  const restoring = fileUndo("restore", first.undoId);
  const refused = expect(restoring).rejects.toThrow(/изменён/);
  const deleting = deleteEntry(path);
  release();
  await second; await refused; await deleting;
  await expect(fsp.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("failed readback refuses success and keeps the entry", async () => {
  const path = await existing();
  const written = await writeFile(path, "NEW");
  const realOpen = fsp.open.bind(fsp);
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (args[1] === "r+") vi.spyOn(handle, "write").mockResolvedValue({ bytesWritten: 3, buffer: Buffer.alloc(3) } as never);
    return handle;
  });
  await expect(fileUndo("restore", written.undoId)).rejects.toThrow(/обратное чтение/);
  expect(await fsp.readFile(path, "utf8")).toBe("NEW");
  expect((await entries())[0]?.id).toBe(written.undoId);
});

it("denies protected paths and failed writes without registering snapshots", async () => {
  const path = join(root, ".env");
  await fsp.writeFile(path, "secret");
  await expect(writeFile(path, "replace")).rejects.toThrow();
  await expect(writeFile(root, "cannot write directory")).rejects.toThrow();
  expect(await entries()).toEqual([]);
  expect(await fsp.readFile(path, "utf8")).toBe("secret");
});

it("rejects a new hardlink before restore, preserving both linked files", async () => {
  const path = await existing();
  const written = await writeFile(path, "new");
  const link = join(root, "alias.txt");
  await fsp.link(path, link);
  await expect(fileUndo("restore", written.undoId)).rejects.toThrow(/одной ссылкой/);
  expect(await fsp.readFile(link, "utf8")).toBe("new");
});

it("existing hardlinks and oversized post-images report unsupported undo", async () => {
  const path = await existing();
  await fsp.link(path, join(root, "alias.txt"));
  const linked = await writeFile(path, "new");
  expect(linked).toMatchObject({ undoAvailable: false, note: expect.stringMatching(/одной ссылкой/) });
  const other = join(root, "other.txt"); await fsp.writeFile(other, "old");
  const large = await writeFile(other, "x".repeat(1024 * 1024 + 1));
  expect(large).toMatchObject({ undoAvailable: false, note: expect.stringMatching(/1 MiB/) });
  expect(await entries()).toEqual([]);
});
