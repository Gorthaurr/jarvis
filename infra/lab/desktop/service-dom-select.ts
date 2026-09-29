/**
 * Подмножество CSS-селекторов для DOM-модели лаборатории: tag, #id, .class, [attr], [attr=v], :nth-of-type(n),
 * комбинаторы «пробел» и «>», список через запятую. Этого хватает для селекторов, которые выдаёт inspect (selFor) и
 * которыми пользуется web_act. Непонятный синтаксис — честная ошибка, а не «ничего не нашлось».
 */
import { type DomNode, walk } from "./service-dom.js";

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
  nth?: number;
}
interface Link {
  comp: Compound;
  /** Связь с ЛЕВЫМ соседом цепочки. */
  comb: " " | ">";
}

const unesc = (s: string): string => s.replace(/\\(.)/gu, "$1");

/** Разбить по запятым вне скобок/кавычек. */
function splitList(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < sel.length; i += 1) {
    const ch = sel[i]!;
    if (ch === "\\") cur += ch + (sel[++i] ?? "");
    else {
      if (quote) quote = ch === quote ? "" : quote;
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[" || ch === "(") depth += 1;
      else if (ch === "]" || ch === ")") depth -= 1;
      if (ch === "," && !quote && depth === 0) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseChain(sel: string): Link[] {
  const links: Link[] = [];
  let i = 0;
  let comb: " " | ">" = " ";
  const bad = (): never => {
    throw new Error(`селектор «${sel}» не поддержан лабораторией (нужны tag, #id, .class, [attr], :nth-of-type, « », «>»)`);
  };
  while (i < sel.length) {
    while (sel[i] === " ") i += 1;
    if (sel[i] === ">") {
      comb = ">";
      i += 1;
      continue;
    }
    if (i >= sel.length) break;
    const comp: Compound = { classes: [], attrs: [] };
    const start = i;
    const ident = (): string => {
      let s = "";
      while (i < sel.length && !/[\s>#.[:]/u.test(sel[i]!)) s += sel[i] === "\\" ? sel[i++]! + (sel[i++] ?? "") : sel[i++]!;
      return unesc(s);
    };
    while (i < sel.length && !/[\s>]/u.test(sel[i]!)) {
      const ch = sel[i]!;
      if (ch === "#") {
        i += 1;
        comp.id = ident();
      } else if (ch === ".") {
        i += 1;
        comp.classes.push(ident());
      } else if (ch === "[") {
        let j = i + 1;
        let quote = "";
        while (j < sel.length && (quote || sel[j] !== "]")) {
          if (sel[j] === "\\") j += 1;
          else if (quote) quote = sel[j] === quote ? "" : quote;
          else if (sel[j] === '"' || sel[j] === "'") quote = sel[j]!;
          j += 1;
        }
        const m = /^\s*([^\s=~|^$*]+)\s*(?:=\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+?)))?\s*$/u.exec(sel.slice(i + 1, j));
        if (!m) bad();
        comp.attrs.push({ name: m![1]!.toLowerCase(), ...(m![2] !== undefined || m![3] !== undefined || m![4] !== undefined ? { value: unesc(m![2] ?? m![3] ?? m![4] ?? "") } : {}) });
        i = j + 1;
      } else if (ch === ":") {
        const m = /^:nth-of-type\((\d+)\)/u.exec(sel.slice(i));
        if (!m) bad();
        comp.nth = Number(m![1]);
        i += m![0].length;
      } else if (ch === "*") i += 1;
      else if (i === start) {
        comp.tag = ident().toLowerCase();
        if (!/^[a-z][\w:-]*$/u.test(comp.tag)) bad();
      } else bad();
    }
    links.push({ comp, comb });
    comb = " ";
  }
  if (!links.length) bad();
  return links;
}

function matchCompound(n: DomNode, c: Compound): boolean {
  if (n.tag === "#text" || n.tag === "#root") return false;
  if (c.tag && n.tag !== c.tag) return false;
  if (c.id !== undefined && n.attrs.id !== c.id) return false;
  if (c.classes.length) {
    const have = (n.attrs.class ?? "").split(/\s+/u);
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  for (const a of c.attrs) {
    if (!(a.name in n.attrs)) return false;
    if (a.value !== undefined && n.attrs[a.name] !== a.value) return false;
  }
  if (c.nth !== undefined) {
    const same = (n.parent?.children ?? []).filter((x) => x.tag === n.tag);
    if (same.indexOf(n) + 1 !== c.nth) return false;
  }
  return true;
}

function matchChain(n: DomNode, chain: Link[], idx: number): boolean {
  const link = chain[idx]!;
  if (!matchCompound(n, link.comp)) return false;
  if (idx === 0) return true;
  if (link.comb === ">") return n.parent !== undefined && matchChain(n.parent, chain, idx - 1);
  for (let p = n.parent; p; p = p.parent) if (matchChain(p, chain, idx - 1)) return true;
  return false;
}

/** Все элементы, подходящие под селектор, в порядке документа. Бросает на неподдержанном синтаксисе. */
export function queryAll(root: DomNode, selector: string): DomNode[] {
  const chains = splitList(selector).map(parseChain);
  const out: DomNode[] = [];
  walk(root, (n) => {
    if (chains.some((c) => matchChain(n, c, c.length - 1))) out.push(n);
  });
  return out;
}
