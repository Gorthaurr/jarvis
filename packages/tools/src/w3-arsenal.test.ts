/**
 * W3 пакет C (L-7, L-8, L-10): арсенал, который модель видит каждый ход.
 *  - каталог холодных: строка целыми фразами ≤ 160, без висячих скобок/кавычек, с предусловием у app_channel_learn/web_login;
 *  - вес горячего набора ≤ HOT_CHARS_CEILING (Σ JSON схем, что уходят в tools[] каждого хода);
 *  - L-7-страж: каждая ссылка «инструмент{поле…}» / «инструмент с поле=» в описаниях, схемах и подсказках каталога
 *    называет существующий инструмент и существующее поле (или значение enum) — «act с pattern=setValue» ловится;
 *  - фасад web_read{view:"elements"} → web_inspect (горячий путь к глазам невидимого браузера).
 * Реверт-проверка (сделана): старый toolCatalogLine (первая фраза до 100) — падает каталог; +10K к описанию горячего —
 * падает вес; вернуть «act с pattern=setValue» в input_type — падает страж; убрать case "web_read" из facades — фасад.
 */
import { describe, expect, it } from "vitest";
import {
  CATALOG_HINTS,
  COLD_TOOL_NAMES,
  FACADE_TOOL_NAMES,
  HOT_CHARS_CEILING,
  TOOL_SCHEMAS,
  TOOLS_BY_NAME,
  canonicalToolCall,
  hotToolChars,
  toolCatalogLine,
} from "./index.js";

type S = Record<string, unknown>;

/** Независимый от catalog.ts судья баланса: скобки/«ёлочки» парны, прямые кавычки чётны (апостроф внутри слова — не кавычка). */
function balanceDefects(text: string): string[] {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "«": "»" };
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  const bad: string[] = [];
  for (const ch of text) {
    if (ch in pairs) stack.push(ch);
    else if (closers.has(ch)) {
      if (pairs[stack.at(-1) ?? ""] === ch) stack.pop();
      else bad.push(`лишняя ${ch}`);
    }
  }
  if (stack.length) bad.push(`не закрыто: ${stack.join("")}`);
  for (const q of ['"', "`"]) if (text.split(q).length % 2 === 0) bad.push(`непарная ${q}`);
  const singles = [...text.matchAll(/(?<!\p{L})'|'(?!\p{L})/gu)].length;
  if (singles % 2 === 1) bad.push("непарная '");
  return bad;
}

describe("L-10: каталог холодных инструментов", () => {
  const cold = TOOL_SCHEMAS.filter((t) => COLD_TOOL_NAMES.has(t.name));

  it("строка каталога: ≤ 160 символов описания, без висячих скобок и кавычек, без служебных пометок", () => {
    const defects: string[] = [];
    for (const t of cold) {
      const line = toolCatalogLine(t);
      const body = line.slice(`- ${t.name}: `.length);
      if (!line.startsWith(`- ${t.name}: `)) defects.push(`${t.name}: формат`);
      if (body.length > 160) defects.push(`${t.name}: ${body.length} > 160`);
      if (body.length < 25) defects.push(`${t.name}: пусто/обрубок «${body}»`);
      if (/ActionCommand|\(§/u.test(body)) defects.push(`${t.name}: служебная пометка`);
      for (const d of balanceDefects(body)) defects.push(`${t.name}: ${d} в «${body}»`);
    }
    expect(defects).toEqual([]);
  });

  it("предусловие не теряется: app_channel_learn — только по факту пробы; web_login — когда не залогинен и входит владелец", () => {
    const learn = toolCatalogLine(TOOLS_BY_NAME["app_channel_learn"]!);
    expect(learn).toMatch(/probe/u);
    expect(learn).toMatch(/по факту|при успехе/u);
    const login = toolCatalogLine(TOOLS_BY_NAME["web_login"]!);
    expect(login).toMatch(/не залогинен/iu);
    expect(login).toMatch(/входит сам/u);
    // Холодный двойник фасада отсылает к горячему пути — иначе модель тратит раунд на tool_load.
    expect(toolCatalogLine(TOOLS_BY_NAME["web_inspect"]!)).toMatch(/web_read\{view:'elements'/u);
  });

  it("подсказки каталога — только для существующих холодных инструментов (иначе мёртвая строка)", () => {
    for (const name of Object.keys(CATALOG_HINTS)) expect(COLD_TOOL_NAMES.has(name), name).toBe(true);
  });
});

describe("L-10: вес горячего набора", () => {
  it(`Σ JSON горячих схем ≤ HOT_CHARS_CEILING (${HOT_CHARS_CEILING}); сам потолок не выше 65K`, () => {
    expect(HOT_CHARS_CEILING).toBeLessThanOrEqual(65_000);
    expect(hotToolChars()).toBeLessThanOrEqual(HOT_CHARS_CEILING);
  });
});

/** Все имена свойств и все значения enum/const на любой глубине схемы. */
function schemaVocabulary(schema: unknown, props = new Set<string>(), values = new Set<string>()): { props: Set<string>; values: Set<string> } {
  if (Array.isArray(schema)) {
    for (const x of schema) schemaVocabulary(x, props, values);
    return { props, values };
  }
  if (!schema || typeof schema !== "object") return { props, values };
  const s = schema as S;
  if (s.properties && typeof s.properties === "object") for (const k of Object.keys(s.properties)) props.add(k);
  if (Array.isArray(s.enum)) for (const v of s.enum) values.add(String(v));
  if (typeof s.const === "string") values.add(s.const);
  for (const v of Object.values(s)) if (v && typeof v === "object") schemaVocabulary(v, props, values);
  return { props, values };
}

/** Все тексты-описания инструмента: верхнее и вложенные description схемы. */
function descriptionsOf(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((x) => descriptionsOf(x, out));
  else if (schema && typeof schema === "object")
    for (const [k, v] of Object.entries(schema as S)) {
      if (k === "description" && typeof v === "string") out.push(v);
      else descriptionsOf(v, out);
    }
  return out;
}

interface Ref {
  tool: string;
  field: string;
  as: "key" | "bare" | "eq";
}

/** Ссылки «имя{ключ: …, голое, …}» (ключи верхнего уровня фигурных скобок) и «имя с поле=». */
function toolRefs(text: string): Ref[] {
  const out: Ref[] = [];
  for (const m of text.matchAll(/(?<![\w.$'"-])([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\{/gu)) {
    const tool = m[1]!;
    if (!(tool in TOOLS_BY_NAME) && !FACADE_TOOL_NAMES.has(tool) && !tool.includes("_")) continue; // не инструмент (форма ответа)
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i += 1) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
    const parts: string[] = [];
    let cur = "";
    let d = 0;
    for (const ch of text.slice(start, i - 1)) {
      if ("{[(".includes(ch)) d += 1;
      else if ("}])".includes(ch)) d -= 1;
      if (ch === "," && d === 0) (parts.push(cur), (cur = ""));
      else cur += ch;
    }
    parts.push(cur);
    for (const p of parts) {
      const k = /^\s*([A-Za-z_]\w*)\s*(:)?/u.exec(p);
      if (k) out.push({ tool, field: k[1]!, as: k[2] ? "key" : "bare" });
    }
  }
  for (const m of text.matchAll(/(?<![\w.$-])([a-z][a-z0-9]*(?:_[a-z0-9]+)*) с ([A-Za-z_]\w*)=/gu)) {
    if (m[1]! in TOOLS_BY_NAME || FACADE_TOOL_NAMES.has(m[1]!)) out.push({ tool: m[1]!, field: m[2]!, as: "eq" });
  }
  return out;
}

/** Нарушения стража в тексте: неизвестный инструмент, ключ не из схемы, голое слово не поле и не значение enum. */
function staleRefs(text: string): string[] {
  return toolRefs(text).flatMap((r) => {
    const t = TOOLS_BY_NAME[r.tool];
    if (!t) return [`${r.tool}: нет такого инструмента`];
    const { props, values } = schemaVocabulary(t.input_schema);
    if (props.has(r.field)) return [];
    if (r.as === "bare" && values.has(r.field)) return [];
    return [`${r.tool}{${r.field}}: нет такого поля`];
  });
}

describe("L-7: ссылки описаний на поля инструментов существуют", () => {
  it("каждое «инструмент{поле}» / «инструмент с поле=» в описаниях, схемах и подсказках каталога — реальное поле", () => {
    const bad: string[] = [];
    for (const t of TOOL_SCHEMAS) for (const d of [t.description, ...descriptionsOf(t.input_schema)]) for (const x of staleRefs(d)) bad.push(`${t.name}: ${x}`);
    for (const [name, hint] of Object.entries(CATALOG_HINTS)) for (const x of staleRefs(hint)) bad.push(`каталог ${name}: ${x}`);
    expect(bad).toEqual([]);
  });

  it("страж на подложке: ловит «act с pattern=setValue», ключ не из схемы и выдуманный инструмент; реальные — пропускает", () => {
    expect(staleRefs("FALLBACK: применяй, только когда act с pattern=setValue невозможен")).toEqual(["act{pattern}: нет такого поля"]);
    expect(staleRefs("зови web_act{intent:'click', selector:'#x'}")).toEqual(["web_act{selector}: нет такого поля"]);
    expect(staleRefs("потом nope_tool{x:1}")).toEqual(["nope_tool: нет такого инструмента"]);
    expect(staleRefs("look{what:'windows'} → window{op:'focus', query} → act{target:{x,y}, physical:true}; wait_for{condition:{kind:'file'}}")).toEqual([]);
    expect(staleRefs("look{windows} и code_run{background}")).toEqual([]); // голое значение enum / голое поле
  });
});

describe("L-8: фасад web_read{view:'elements'} → web_inspect", () => {
  it("elements → web_inspect с query/cap; text/без view → сам web_read без полей; вход не мутирует", () => {
    const input = { view: "elements", query: "Войти", cap: 20, junk: 1 };
    const c = canonicalToolCall("web_read", input);
    expect(c).toEqual({ name: "web_inspect", input: { query: "Войти", cap: 20 } });
    expect(input).toEqual({ view: "elements", query: "Войти", cap: 20, junk: 1 });
    expect(canonicalToolCall("web_read", { view: "text", query: "x" })).toEqual({ name: "web_read", input: {} });
    expect(canonicalToolCall("web_read", {})).toEqual({ name: "web_read", input: {} });
  });

  it("путь горячий: web_read в горячем наборе, его схема знает view elements и query; web_inspect — холодный двойник", () => {
    expect(COLD_TOOL_NAMES.has("web_read")).toBe(false);
    expect(COLD_TOOL_NAMES.has("web_inspect")).toBe(true);
    const props = (TOOLS_BY_NAME["web_read"]!.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.view?.enum).toContain("elements");
    expect(props.query).toBeDefined();
  });
});
