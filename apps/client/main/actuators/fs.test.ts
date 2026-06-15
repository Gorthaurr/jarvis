import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFile,
  deleteEntry,
  expandPath,
  listDir,
  makeDir,
  moveEntry,
  readFile,
  search,
  writeFile,
} from "./fs.js";

let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "jarvis-fstest-"));
});
afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("fs actuator (§6) — CRUD на файлах", () => {
  it("write создаёт файл, read возвращает содержимое", async () => {
    const p = join(root, "a.txt");
    const w = await writeFile(p, "привет мир");
    expect(w.created).toBe(true);
    const r = await readFile(p);
    expect(r.content).toBe("привет мир");
    expect(r.truncated).toBe(false);
  });

  it("write по существующему = перезапись (created=false)", async () => {
    const p = join(root, "a.txt");
    const w = await writeFile(p, "новое");
    expect(w.created).toBe(false);
    expect((await readFile(p)).content).toBe("новое");
  });

  it("createDirs создаёт недостающие родительские каталоги", async () => {
    const p = join(root, "deep", "nested", "b.txt");
    await writeFile(p, "x", true);
    expect((await readFile(p)).content).toBe("x");
  });

  it("append дописывает, не затирая", async () => {
    const p = join(root, "c.txt");
    await writeFile(p, "1");
    await appendFile(p, "2");
    expect((await readFile(p)).content).toBe("12");
  });

  it("read с maxBytes усекает и помечает truncated", async () => {
    const p = join(root, "d.txt");
    await writeFile(p, "abcdef");
    const r = await readFile(p, 3);
    expect(r.content).toBe("abc");
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(6);
  });

  it("mkdir + list перечисляет содержимое", async () => {
    const dir = join(root, "listme");
    await makeDir(dir);
    await writeFile(join(dir, "f1.txt"), "a");
    await writeFile(join(dir, "f2.txt"), "bb");
    const { entries } = await listDir(dir);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["f1.txt", "f2.txt"]);
    expect(entries.find((e) => e.name === "f2.txt")?.size).toBe(2);
  });

  it("move переименовывает файл", async () => {
    const from = join(root, "src.txt");
    const to = join(root, "dst.txt");
    await writeFile(from, "data");
    await moveEntry(from, to);
    expect((await readFile(to)).content).toBe("data");
    await expect(readFile(from)).rejects.toBeTruthy();
  });

  it("delete удаляет файл (необратимо)", async () => {
    const p = join(root, "die.txt");
    await writeFile(p, "x");
    const res = await deleteEntry(p);
    expect(res.deleted).toBe(true);
    await expect(readFile(p)).rejects.toBeTruthy();
  });

  it("search по имени и по содержимому", async () => {
    const dir = join(root, "search");
    await makeDir(dir);
    await writeFile(join(dir, "report-2024.txt"), "квартальная выручка");
    await writeFile(join(dir, "notes.txt"), "просто заметки");
    const byName = await search(dir, "report");
    expect(byName.matches.map((m) => m.path).some((p) => p.includes("report-2024"))).toBe(true);
    const byContent = await search(dir, "выручка", true);
    expect(byContent.matches[0]?.path).toContain("report-2024");
    expect(byContent.matches[0]?.line).toBe(1);
  });

  it("expandPath раскрывает переменные окружения", () => {
    process.env.JARVIS_TEST_DIR = root;
    expect(expandPath("%JARVIS_TEST_DIR%")).toBe(root);
  });
});
