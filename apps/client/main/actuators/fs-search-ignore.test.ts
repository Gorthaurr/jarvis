/**
 * fs.search: служебные каталоги (node_modules/.git/dist…) по умолчанию НЕ обходятся (причина №6
 * USER_SCENARIOS_2026-09-02) — но пропуск ВИДЕН (ignoredDirs/ignoredNames/note), exhausted не ломается,
 * ignore:[] возвращает полный обход, а папка по имени всё равно находится.
 */
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { search } from "./fs.js";

/** Фикстура пишется node:fs напрямую: актуатор writeFile по self-guard не пишет в node_modules (и это правильно). */
async function put(rel: string[], text: string): Promise<void> {
  const p = join(root, ...rel);
  await fsp.mkdir(join(p, ".."), { recursive: true });
  await fsp.writeFile(p, text, "utf8");
}

let root: string;
beforeAll(async () => {
  root = await fsp.mkdtemp(join(tmpdir(), "jarvis-fsign-"));
  await put(["src", "a.ts"], "const needle = 1;\n");
  await put(["node_modules", "lib", "b.js"], "needle in package\n");
  await put(["dist", "c.js"], "needle built\n");
  await put([".git", "config"], "needle = repo\n");
});
afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe("fs.search × ignore служебных каталогов", () => {
  it("по умолчанию node_modules/.git/dist пропускаются: одно совпадение в src, ignoredDirs=3, exhausted=true, note называет их и путь снятия", async () => {
    const r = await search(root, "needle", true);
    expect(r.matches.map((m) => m.path)).toEqual([join(root, "src", "a.ts")]);
    expect(r.ignoredDirs).toBe(3);
    expect(r.ignoredNames.sort()).toEqual([".git", "dist", "node_modules"]);
    expect(r.exhausted).toBe(true); // намеренный пропуск ≠ «не досмотрел»
    expect(r.note).toContain("node_modules");
    expect(r.note).toContain("ignore:[]");
    // Серверный кап режет JSON с хвоста → exhausted/stopReason/note обязаны стоять ПЕРЕД matches.
    expect(Object.keys(r).at(-1)).toBe("matches");
  });

  it("ignore:[] → обход всего: четыре совпадения, ignoredDirs=0, note нет", async () => {
    const r = await search(root, "needle", true, 50, { ignore: [] });
    expect(r.matches).toHaveLength(4);
    expect(r.ignoredDirs).toBe(0);
    expect(r.note).toBeUndefined();
  });

  it("свой список: ignore:[\"dist\"] — node_modules и .git обходятся, dist нет", async () => {
    const r = await search(root, "needle", true, 50, { ignore: ["dist"] });
    expect(r.matches.map((m) => m.path).sort()).toEqual([join(root, ".git", "config"), join(root, "node_modules", "lib", "b.js"), join(root, "src", "a.ts")].sort());
    expect(r.ignoredNames).toEqual(["dist"]);
  });

  it("папка с игнорируемым именем по ИМЕНИ находится («где node_modules?»), внутрь — не заходим", async () => {
    const r = await search(root, "node_modules", false);
    expect(r.matches).toEqual([{ path: join(root, "node_modules"), kind: "dir" }]);
    expect(r.ignoredDirs).toBe(3);
  });

  it("регистр имени не важен (.Cache тоже служебный; NTFS регистронезависим — имя без коллизии с фикстурой)", async () => {
    await put([".Cache", "x.txt"], "needle upper\n");
    const r = await search(root, "needle", true);
    expect(r.matches.map((m) => m.path)).toEqual([join(root, "src", "a.ts")]);
    expect(r.ignoredDirs).toBe(4);
  });
});
