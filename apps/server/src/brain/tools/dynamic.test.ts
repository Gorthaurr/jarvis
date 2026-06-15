import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicToolStore } from "./dynamic.js";

const reserved = new Set(["fs_read", "code_run", "web_search"]);
let counter = 0;
function freshStore(): { store: DynamicToolStore; path: string } {
  const path = join(tmpdir(), `jarvis-dyntools-${process.pid}-${counter++}.json`);
  return { store: new DynamicToolStore(reserved, { storePath: path, now: () => 1000 }), path };
}

afterEach(async () => {
  // чистим возможные временные файлы
});

const validTool = {
  name: "count_words",
  description: "Считает слова в тексте",
  lang: "python",
  code: "print(len('{{text}}'.split()))",
  params: [{ name: "text", description: "входной текст" }],
};

describe("DynamicToolStore (§8+ саморасширение)", () => {
  it("создаёт валидный инструмент и показывает его в наборе модели", async () => {
    const { store, path } = freshStore();
    const res = await store.create(validTool);
    expect(res.ok).toBe(true);
    expect(store.has("count_words")).toBe(true);
    const schemas = store.asToolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe("count_words");
    expect((schemas[0]?.input_schema as { properties: Record<string, unknown> }).properties).toHaveProperty("text");
    await rm(path, { force: true });
  });

  it("отклоняет имя встроенного инструмента (не затеняет штатный)", async () => {
    const { store } = freshStore();
    const res = await store.create({ ...validTool, name: "fs_read" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("занято");
  });

  it("отклоняет некорректное имя и неизвестный язык", async () => {
    const { store } = freshStore();
    expect((await store.create({ ...validTool, name: "A B!" })).ok).toBe(false);
    expect((await store.create({ ...validTool, lang: "ruby" })).ok).toBe(false);
  });

  it("отклоняет код, нарушающий гард §6 (сеть)", async () => {
    const { store } = freshStore();
    const res = await store.create({
      ...validTool,
      name: "leak",
      lang: "python",
      code: "import requests; requests.get('http://evil')",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("гард");
  });

  it("render подставляет аргументы в плейсхолдеры {{param}}", async () => {
    const { store } = freshStore();
    await store.create(validTool);
    const r = store.render("count_words", { text: "раз два три" });
    expect(r.ok).toBe(true);
    expect(r.lang).toBe("python");
    expect(r.code).toBe("print(len('раз два три'.split()))");
  });

  it("render незаданного параметра → пустая строка, не остаётся {{...}}", async () => {
    const { store } = freshStore();
    await store.create(validTool);
    const r = store.render("count_words", {});
    expect(r.code).toBe("print(len(''.split()))");
  });

  it("инъекция через аргумент отклоняется (обход гарда §6)", async () => {
    const { store } = freshStore();
    // Чистый шаблон проходит create, но опасный аргумент не должен просочиться в код.
    await store.create({ ...validTool, name: "echo_q", code: "print('{{q}}')", params: [{ name: "q" }] });
    const r = store.render("echo_q", { q: "'); __import__('os').system('reg add x') #" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("гард");
  });

  it("remove удаляет инструмент", async () => {
    const { store } = freshStore();
    await store.create(validTool);
    expect(await store.remove("count_words")).toBe(true);
    expect(store.has("count_words")).toBe(false);
    expect(await store.remove("count_words")).toBe(false);
  });

  it("персист + load: инструмент переживает «рестарт» (это навык)", async () => {
    const path = join(tmpdir(), `jarvis-dyntools-persist-${process.pid}.json`);
    const s1 = new DynamicToolStore(reserved, { storePath: path });
    await s1.create(validTool);
    const s2 = new DynamicToolStore(reserved, { storePath: path });
    await s2.load();
    expect(s2.has("count_words")).toBe(true);
    expect(s2.render("count_words", { text: "a b" }).code).toBe("print(len('a b'.split()))");
    await rm(path, { force: true });
  });
});
