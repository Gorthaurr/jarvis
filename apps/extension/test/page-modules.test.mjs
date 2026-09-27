// ЗАКОН page/*.js (W4, разрез background.js): функция уходит в страницу своим toString() — без модуля вокруг
// (executeScript расширения, CDP невидимого браузера клиента). Сторож поведением компилятора, не грепом: каждый экспорт —
// функция, в её исходнике TypeScript (lib ES+DOM) не находит ни одного свободного имени сверх глобалов страницы
// (хелпер/константа уровня модуля = ReferenceError в странице, даже на ветке, которую стенд не гоняет); соседний .d.ts
// описывает ровно эти экспорты (по нему клиент исполняет те же функции).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "page");
const files = readdirSync(pageDir).filter((f) => f.endsWith(".js")).sort();
const ts = createRequire(import.meta.url)("typescript");

/** Имена, которых компилятор не нашёл в исходниках (каждый — отдельный скрипт `(fn);`, общий только lib ES+DOM). */
function unresolvedNames(sources) {
  const opts = { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], types: [] };
  const host = ts.createCompilerHost(opts);
  const virt = new Map(Object.entries(sources).map(([n, src]) => [`/virtual/${n}.js`, `(${src});\n`]));
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (f, lang, ...r) => (virt.has(f) ? ts.createSourceFile(f, virt.get(f), lang) : getSourceFile.call(host, f, lang, ...r));
  host.fileExists = (f) => virt.has(f) || fileExists.call(host, f);
  host.readFile = (f) => virt.get(f) ?? readFile.call(host, f);
  const diags = ts.getPreEmitDiagnostics(ts.createProgram([...virt.keys()], opts, host));
  return diags
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
    .filter((m) => /^Cannot find name/u.test(m));
}

describe("page/*.js — самодостаточные функции для страницы", () => {
  const mods = {};
  it("каждый файл экспортирует только функции, и их не меньше одной", async () => {
    assert.ok(files.length >= 3, `в page/ ${files.length} файлов`);
    for (const f of files) {
      mods[f] = await import(pathToFileURL(join(pageDir, f)).href);
      const ex = Object.entries(mods[f]);
      assert.ok(ex.length > 0, `${f}: нет экспортов`);
      for (const [name, v] of ex) assert.equal(typeof v, "function", `${f}: экспорт ${name} — не функция`);
    }
  });

  it("исходник каждой функции не ссылается ни на что вне себя (кроме глобалов страницы)", async () => {
    const sources = {};
    for (const f of files) for (const [name, fn] of Object.entries(await import(pathToFileURL(join(pageDir, f)).href))) sources[name] = fn.toString();
    assert.deepEqual(unresolvedNames(sources), []);
  });

  it("сторож видит свободное имя (контроль самого сторожа)", () => {
    assert.deepEqual(unresolvedNames({ probe: "function probe() { return helperOfModule(document.title); }" }), ["Cannot find name 'helperOfModule'."]);
  });

  it(".d.ts рядом описывает ровно экспорты .js", async () => {
    for (const f of files) {
      const dts = readFileSync(join(pageDir, f.replace(/\.js$/u, ".d.ts")), "utf8");
      const declared = [...dts.matchAll(/^export (?:declare )?function (\w+)/gmu)].map((m) => m[1]).sort();
      const exported = Object.keys(await import(pathToFileURL(join(pageDir, f)).href)).sort();
      assert.deepEqual(declared, exported, f);
    }
  });
});
