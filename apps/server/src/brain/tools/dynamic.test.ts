import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicToolStore } from "./dynamic.js";

const reserved = new Set(["fs_read", "code_run", "web_search"]);
const U = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
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

describe("DynamicToolStore (§8+ саморасширение, §6B/B3 партиция по userId)", () => {
  it("создаёт валидный инструмент и показывает его в наборе модели владельца", async () => {
    const { store, path } = freshStore();
    const res = await store.create(U, validTool);
    expect(res.ok).toBe(true);
    expect(store.has(U, "count_words")).toBe(true);
    const schemas = store.asToolSchemas(U);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe("count_words");
    expect((schemas[0]?.input_schema as { properties: Record<string, unknown> }).properties).toHaveProperty("text");
    await rm(path, { force: true });
  });

  it("§6B/B3: инструмент одного userId НЕ виден/не вызывается другим (фикс шаринга code-exec)", async () => {
    const { store, path } = freshStore();
    await store.create(U, validTool);
    expect(store.has(U, "count_words")).toBe(true);
    expect(store.has(U2, "count_words")).toBe(false); // другой юзер не видит
    expect(store.asToolSchemas(U2)).toHaveLength(0); // и нет в его наборе
    expect(store.render(U2, "count_words", { text: "a b" }).ok).toBe(false); // и не может исполнить
    await rm(path, { force: true });
  });

  it("отклоняет имя встроенного инструмента (не затеняет штатный)", async () => {
    const { store } = freshStore();
    const res = await store.create(U, { ...validTool, name: "fs_read" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("занято");
  });

  it("отклоняет некорректное имя и неизвестный язык", async () => {
    const { store } = freshStore();
    expect((await store.create(U, { ...validTool, name: "A B!" })).ok).toBe(false);
    expect((await store.create(U, { ...validTool, lang: "ruby" })).ok).toBe(false);
  });

  it("сеть/реестр в самописном инструменте РАЗРЕШЕНЫ (полное управление Windows)", async () => {
    const { store } = freshStore();
    const res = await store.create(U, {
      ...validTool,
      name: "net_ok",
      lang: "python",
      code: "import urllib.request; print(urllib.request.urlopen('http://x').status)",
    });
    expect(res.ok).toBe(true);
  });

  it("отклоняет код, нарушающий РЕЛЬС §4 (выключение питания — только system_power)", async () => {
    const { store } = freshStore();
    const res = await store.create(U, {
      ...validTool,
      name: "killpower",
      lang: "powershell",
      code: "Stop-Computer -Force",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("гард");
  });

  it("render подставляет аргументы в плейсхолдеры {{param}}", async () => {
    const { store } = freshStore();
    await store.create(U, validTool);
    const r = store.render(U, "count_words", { text: "раз два три" });
    expect(r.ok).toBe(true);
    expect(r.lang).toBe("python");
    expect(r.code).toBe("print(len('раз два три'.split()))");
  });

  it("render незаданного параметра → пустая строка, не остаётся {{...}}", async () => {
    const { store } = freshStore();
    await store.create(U, validTool);
    const r = store.render(U, "count_words", {});
    expect(r.code).toBe("print(len(''.split()))");
  });

  it("инъекция РЕЛЬСА через аргумент отклоняется (нельзя обойти §4: питание/самоубийство)", async () => {
    const { store } = freshStore();
    await store.create(U, { ...validTool, name: "echo_q", code: "print('{{q}}')", params: [{ name: "q" }] });
    const r = store.render(U, "echo_q", { q: "'); import os; os.system('shutdown /s') #" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("гард");
  });

  it("remove удаляет инструмент владельца", async () => {
    const { store } = freshStore();
    await store.create(U, validTool);
    expect(await store.remove(U, "count_words")).toBe(true);
    expect(store.has(U, "count_words")).toBe(false);
    expect(await store.remove(U, "count_words")).toBe(false);
  });

  it("персист + load: инструмент переживает «рестарт» и сохраняет владельца", async () => {
    const path = join(tmpdir(), `jarvis-dyntools-persist-${process.pid}.json`);
    const s1 = new DynamicToolStore(reserved, { storePath: path });
    await s1.create(U, validTool);
    const s2 = new DynamicToolStore(reserved, { storePath: path });
    await s2.load();
    expect(s2.has(U, "count_words")).toBe(true);
    expect(s2.has(U2, "count_words")).toBe(false); // владелец сохранён, не утёк всем
    expect(s2.render(U, "count_words", { text: "a b" }).code).toBe("print(len('a b'.split()))");
    await rm(path, { force: true });
  });

  it("континьюити: legacy-запись без userId грузится в раздел dev", async () => {
    const DEV = "00000000-0000-0000-0000-000000000001";
    const path = join(tmpdir(), `jarvis-dyntools-legacy-${process.pid}-${counter++}.json`);
    // legacy-снимок (до B3) — без поля userId
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path,
      JSON.stringify([{ name: "count_words", description: "x", lang: "python", code: "print(1)", params: [], createdAt: 1, runCount: 0 }]),
      "utf8",
    );
    const s = new DynamicToolStore(reserved, { storePath: path });
    await s.load();
    expect(s.has(DEV, "count_words")).toBe(true); // прочитано в раздел dev
    await rm(path, { force: true });
  });
});
