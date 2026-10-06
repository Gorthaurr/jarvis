export { decodeEntities,parseHtml } from "./service-dom-parser.js";
/**
 * Минимальная DOM-модель страниц лабораторного невидимого браузера (без зависимостей): разбор HTML в дерево, видимость,
 * innerText в духе readPage. Не браузер: нет CSS-каскада, скриптов и layout — только то, что нужно inspect/act на
 * статичных страницах из seed.web (hidden/style display:none/type=hidden считаются невидимыми).
 */
export interface DomNode {
  tag: string; // "#root" | "#text" | имя тега в нижнем регистре
  attrs: Record<string, string>;
  children: DomNode[];
  text?: string;
  parent?: DomNode;
}
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "form", "pre", "blockquote", "aside", "fieldset", "br", "hr", "dt", "dd"]);
const INVISIBLE_TAGS = new Set(["head", "script", "style", "noscript", "template", "title", "meta", "link"]);

export function walk(n: DomNode, fn: (n: DomNode) => void): void {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

export function find(n: DomNode, pred: (n: DomNode) => boolean): DomNode | undefined {
  if (pred(n)) return n;
  for (const c of n.children) {
    const r = find(c, pred);
    if (r) return r;
  }
  return undefined;
}

/** Невидим сам или через предка: hidden, display:none/visibility:hidden, type=hidden, служебные теги. */
export function isVisible(n: DomNode): boolean {
  for (let p: DomNode | undefined = n; p; p = p.parent) {
    if (INVISIBLE_TAGS.has(p.tag) || "hidden" in p.attrs) return false;
    if (/display\s*:\s*none|visibility\s*:\s*hidden/iu.test(p.attrs.style ?? "")) return false;
    if (p.tag === "input" && (p.attrs.type ?? "").toLowerCase() === "hidden") return false;
  }
  return true;
}

/** innerText: блоки — с переводами строк, скрытое не читается, пробелы схлопнуты (как readPage). */
export function innerText(n: DomNode): string {
  let out = "";
  const rec = (x: DomNode): void => {
    if (x.tag === "#text") return void (out += x.text ?? "");
    if (INVISIBLE_TAGS.has(x.tag) || "hidden" in x.attrs || /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(x.attrs.style ?? "")) return;
    const block = BLOCK.has(x.tag);
    if (block) out += "\n";
    for (const c of x.children) rec(c);
    if (block) out += "\n";
  };
  rec(n);
  return out.replace(/[\t  ]+/gu, " ").replace(/ ?\n ?/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export const titleOf = (root: DomNode): string => innerTextRaw(find(root, (x) => x.tag === "title"));
function innerTextRaw(n: DomNode | undefined): string {
  if (!n) return "";
  let s = "";
  walk(n, (x) => {
    if (x.tag === "#text") s += x.text ?? "";
  });
  return s.replace(/\s+/gu, " ").trim();
}

/** Является ли содержимое страницы разметкой (иначе — простой текст). */
export const looksLikeHtml = (s: string): boolean => /<\s*(html|body|div|p|a|form|input|button|h[1-6]|span|ul|title)\b/iu.test(s);
