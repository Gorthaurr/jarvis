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

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style"]);
/** Тег закрывает открытый однотипный сиблинг (`<li>a<li>b`). */
const SELF_CLOSING_SIBLING = new Set(["li", "option", "p", "dt", "dd", "tr", "td", "th"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "form", "pre", "blockquote", "aside", "fieldset", "br", "hr", "dt", "dd"]);
/** Блочные теги, которые закрывают открытый <p> (правило HTML-парсера). */
const CLOSES_P = new Set(["ul", "ol", "div", "form", "table", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre", "blockquote", "hr", "fieldset", "nav", "header", "footer", "main", "aside"]);
const INVISIBLE_TAGS = new Set(["head", "script", "style", "noscript", "template", "title", "meta", "link"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", copy: "©" };

export const decodeEntities = (s: string): string =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (m, dec: string, hex: string, name: string) => {
    if (dec) return String.fromCodePoint(Math.min(Number(dec), 0x10ffff));
    if (hex) return String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff));
    return ENTITIES[name.toLowerCase()] ?? m;
  });

const ATTR_RE = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

export function parseHtml(html: string): DomNode {
  const root: DomNode = { tag: "#root", attrs: {}, children: [] };
  let cur = root;
  let i = 0;
  const addText = (t: string): void => {
    if (t) cur.children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(t), parent: cur });
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    addText(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w:-]*)\s*>/u.exec(html.slice(i, i + 80));
    if (close) {
      const name = close[1]!.toLowerCase();
      for (let p: DomNode | undefined = cur; p && p !== root; p = p.parent) {
        if (p.tag === name) {
          cur = p.parent ?? root;
          break;
        }
      }
      i += close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][\w:-]*)/u.exec(html.slice(i, i + 80));
    if (!open) {
      addText("<");
      i += 1;
      continue;
    }
    const tag = open[1]!.toLowerCase();
    i += open[0].length;
    const attrs: Record<string, string> = {};
    for (;;) {
      ATTR_RE.lastIndex = i;
      const m = ATTR_RE.exec(html);
      if (!m || m.index !== i || !m[0]) break;
      attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
      i += m[0].length;
    }
    const gt = html.indexOf(">", i);
    const selfClose = html.slice(i, gt < 0 ? html.length : gt).includes("/");
    i = gt < 0 ? html.length : gt + 1;
    if (cur.parent && ((SELF_CLOSING_SIBLING.has(tag) && cur.tag === tag) || (cur.tag === "p" && CLOSES_P.has(tag)))) cur = cur.parent;
    const node: DomNode = { tag, attrs, children: [], parent: cur };
    cur.children.push(node);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      const stop = end < 0 ? html.length : end;
      if (tag === "script" || tag === "style") node.children.push({ tag: "#text", attrs: {}, children: [], text: html.slice(i, stop), parent: node });
      const gt2 = html.indexOf(">", stop);
      i = end < 0 || gt2 < 0 ? html.length : gt2 + 1;
    } else if (!VOID.has(tag) && !selfClose) cur = node;
  }
  return root;
}

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
