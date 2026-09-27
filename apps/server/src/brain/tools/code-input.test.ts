/**
 * W3 (L-2, G-14): одно правило «python + модуль jarvis в import/from/__import__/importlib» для аренды ввода, долга
 * сверки и отказа фоновому SDK. Формы — как модель реально пишет скрипты (однострочники, отступы, алиасы).
 * Реверт: убери ветку `[;:]` — падает однострочник; убери DYNAMIC_IMPORT — падает `__import__`; убери проверку lang —
 * падает node; сними lookbehind `(?<![\w.])` — падает `import a.jarvis`; убери резолвер реестра — падает самописный.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callDrivesInput, codeDrivesInput, codeResolver } from "./code-input.js";
import { DynamicToolStore } from "./dynamic.js";
import { toolNeedsInput } from "./input-kinds.js";

describe("codeDrivesInput — SDK jarvis в python-коде", () => {
  it.each([
    "import jarvis\njarvis.click('Играть')",
    "import os, jarvis",
    "import jarvis as j\nj.type('привет')",
    "from jarvis import click, press",
    "from jarvis.act import run",
    "def go():\n    import jarvis\n    jarvis.press('enter')",
    "import os; import jarvis; jarvis.click(1, 2)",
    "try: import jarvis\nexcept ImportError: pass",
    "j = __import__('jarvis')",
    'import importlib\nj = importlib.import_module("jarvis")',
    "import time\r\nimport jarvis\r\n",
  ])("да: %j", (code) => {
    expect(codeDrivesInput("python", code)).toBe(true);
  });

  it.each([
    "import jarvis_tools",
    "import myjarvis",
    "import a.jarvis",
    "from jarvisx import y",
    "# import jarvis — не нужен\nprint(1)",
    "print('jarvis')",
    "open(r'C:\\jarvis\\data\\log.txt').read()",
    "import json\nprint(json.dumps({'sum': 4}))",
  ])("нет: %j", (code) => {
    expect(codeDrivesInput("python", code)).toBe(false);
  });

  it("моста нет у node/powershell — их «import jarvis» ввод не драйвит", () => {
    expect(codeDrivesInput("node", "import jarvis from 'jarvis'")).toBe(false);
    expect(codeDrivesInput("powershell", "import jarvis")).toBe(false);
  });
});

describe("toolNeedsInput по ВХОДУ (G-14)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("code_run: SDK — под арендой, обычный код — нет; без входа — по имени, как раньше", () => {
    expect(toolNeedsInput("code_run", { lang: "python", code: "import jarvis\njarvis.click(1,2)" })).toBe(true);
    expect(toolNeedsInput("code_run", { lang: "python", code: "print(2+2)" })).toBe(false);
    expect(toolNeedsInput("code_run")).toBe(false);
  });

  it("самописный инструмент на SDK — под арендой, только через реестр владельца", async () => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-code-input-"));
    const store = new DynamicToolStore(new Set(["code_run"]), { storePath: join(dir, "t.json") });
    expect((await store.create("u1", { name: "click_play", description: "жмёт играть", lang: "python", code: "import jarvis\njarvis.click('Играть')" })).ok).toBe(true);
    expect((await store.create("u1", { name: "word_count", description: "слова", lang: "python", code: "print(len('{{text}}'.split()))", params: [{ name: "text" }] })).ok).toBe(true);
    const own = codeResolver(store, "u1");
    expect(toolNeedsInput("click_play", {}, own)).toBe(true);
    expect(toolNeedsInput("CLICK_PLAY", {}, own)).toBe(true); // имя реестра регистронезависимо
    expect(toolNeedsInput("word_count", { text: "a b" }, own)).toBe(false);
    expect(callDrivesInput("word_count", { text: "import jarvis" }, own)).toBe(true); // SDK может прийти аргументом
    expect(toolNeedsInput("click_play", {}, codeResolver(store, "u2"))).toBe(false); // чужой реестр — не наш инструмент
    expect(toolNeedsInput("click_play", {})).toBe(false); // без резолвера самописный не распознать
  });
});
