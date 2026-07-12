import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFile,
  deleteEntry,
  editFile,
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

  it("search по ИМЕНИ не отдаёт секретные пути (§0, H3)", async () => {
    const dir = join(root, "search-secret");
    await makeDir(dir);
    await fsp.writeFile(join(dir, ".env"), "SECRET=1", "utf8"); // мимо writeFile-guard'а — напрямую в fs
    await writeFile(join(dir, "env-notes.txt"), "не секрет");
    const byName = await search(dir, "env");
    expect(byName.matches.some((m) => m.path.endsWith(".env"))).toBe(false);
    expect(byName.matches.some((m) => m.path.includes("env-notes.txt"))).toBe(true);
  });

  it("expandPath раскрывает переменные окружения", () => {
    process.env.JARVIS_TEST_DIR = root;
    expect(expandPath("%JARVIS_TEST_DIR%")).toBe(root);
  });
});

describe("fs.editFile — точечная правка (§6, для кодинга)", () => {
  const mk = async (content: string): Promise<string> => {
    const p = join(root, `edit-${Math.random().toString(36).slice(2)}.txt`);
    await writeFile(p, content);
    return p;
  };

  it("заменяет уникальный фрагмент, остальное не трогает", async () => {
    const p = await mk("const x = 1;\nconst y = 2;\n");
    const r = await editFile(p, "const y = 2;", "const y = 42;");
    expect(r.replacements).toBe(1);
    expect((await readFile(p)).content).toBe("const x = 1;\nconst y = 42;\n");
  });

  it("фрагмент не найден → ошибка (не молчаливый no-op)", async () => {
    const p = await mk("aaa");
    await expect(editFile(p, "bbb", "ccc")).rejects.toThrow(/не найден/);
  });

  it("неоднозначный фрагмент без replaceAll → ошибка, файл не тронут", async () => {
    const p = await mk("foo foo foo");
    await expect(editFile(p, "foo", "bar")).rejects.toThrow(/встречается 3 раз/);
    expect((await readFile(p)).content).toBe("foo foo foo");
  });

  it("replaceAll заменяет все вхождения", async () => {
    const p = await mk("foo foo foo");
    const r = await editFile(p, "foo", "bar", true);
    expect(r.replacements).toBe(3);
    expect((await readFile(p)).content).toBe("bar bar bar");
  });

  it("new с $-паттернами вставляется БУКВАЛЬНО", async () => {
    const p = await mk("price = OLD");
    await editFile(p, "OLD", "$1 $& ${x}");
    expect((await readFile(p)).content).toBe("price = $1 $& ${x}");
  });

  it("old === new → ошибка", async () => {
    const p = await mk("z");
    await expect(editFile(p, "z", "z")).rejects.toThrow(/одинаков/);
  });

  // § рельсы самомодификации в действии через актуатор fs.
  it("запись в node_modules — отклоняется guard'ом (самосохранность)", async () => {
    await expect(writeFile(join(root, "node_modules", "x.js"), "hack")).rejects.toThrow(/самосохранн/i);
  });
  it("чтение .env — отклоняется guard'ом (секрет §0)", async () => {
    await expect(readFile(join(root, ".env"))).rejects.toThrow(/секрет/i);
  });
});

// Аудит ядра [11]: leaf-гард проверял только сам путь — рекурсивное удаление/перемещение КАТАЛОГА
// сносило/релоцировало node_modules/.env/бинарь ВНУТРИ поддерева мимо рельс. Теперь сверяем поддерево.
describe("fs — рекурсивный self-guard поддерева (§ аудит [11])", () => {
  it("рекурсивное удаление каталога с .env внутри → отказ (не сносим секреты)", async () => {
    const dir = join(root, "guard-del");
    await makeDir(dir);
    await fsp.writeFile(join(dir, ".env"), "SECRET=1", "utf8"); // напрямую, мимо write-guard
    await fsp.writeFile(join(dir, "readme.txt"), "ok", "utf8");
    await expect(deleteEntry(dir, true)).rejects.toThrow(/самосохранн/i);
    expect((await readFile(join(dir, "readme.txt"))).content).toBe("ok"); // каталог цел
  });

  it("рекурсивное удаление каталога с node_modules внутри → отказ", async () => {
    const dir = join(root, "guard-nm");
    await makeDir(join(dir, "node_modules", "pkg"));
    await fsp.writeFile(join(dir, "node_modules", "pkg", "index.js"), "1", "utf8");
    await expect(deleteEntry(dir, true)).rejects.toThrow(/самосохранн/i);
  });

  it("перемещение каталога с .env внутри → отказ (релокация секрета мимо confirm)", async () => {
    const dir = join(root, "guard-mv");
    await makeDir(dir);
    await fsp.writeFile(join(dir, ".env"), "SECRET=1", "utf8");
    await expect(moveEntry(dir, join(root, "guard-mv-moved"))).rejects.toThrow(/самосохранн/i);
  });

  it("рекурсивное удаление ЧИСТОГО каталога (без защищённого внутри) — работает", async () => {
    const dir = join(root, "guard-clean");
    await makeDir(join(dir, "sub"));
    await fsp.writeFile(join(dir, "a.txt"), "1", "utf8");
    await fsp.writeFile(join(dir, "sub", "b.txt"), "2", "utf8");
    const res = await deleteEntry(dir, true);
    expect(res.deleted).toBe(true);
    await expect(readFile(join(dir, "a.txt"))).rejects.toBeTruthy();
  });
});
