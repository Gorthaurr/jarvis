import { queryAll } from "./service-dom-select.js";
import { type DomNode, innerText, isVisible, walk } from "./service-dom.js";
import { type Page, PageFail, editable, fold, isInteractive, labelParts, oneLine } from "./service-page.js";
/** CSS-селектор элемента — те же правила, что в page-скрипте inspect (стабильные атрибуты, иначе путь nth-of-type ≤ 4 уровней). */
export function selFor(n: DomNode): string {
  const esc = (s: string): string => s.replace(/(["\\\]])/gu, "\\$1");
  const id = n.attrs.id;
  if (id && /^[A-Za-z][\w-]*$/u.test(id) && !/\d{4,}/u.test(id) && !/[a-f0-9]{8,}/iu.test(id)) return `#${id}`;
  for (const a of ["data-test-id", "data-testid", "data-marker", "data-qa", "data-test"]) if (n.attrs[a]) return `${n.tag}[${a}="${esc(n.attrs[a]!)}"]`;
  if (n.attrs["aria-label"]) return `${n.tag}[aria-label="${esc(n.attrs["aria-label"])}"]`;
  if (["input", "textarea", "select"].includes(n.tag)) {
    if (n.attrs.name) return `${n.tag}[name="${esc(n.attrs.name)}"]`;
    if (n.attrs.placeholder) return `${n.tag}[placeholder="${esc(n.attrs.placeholder)}"]`;
  }
  const parts: string[] = [];
  let d = 0;
  for (let x: DomNode | undefined = n; x && x.tag !== "#root" && d < 4; x = x.parent, d += 1) {
    const same = (x.parent?.children ?? []).filter((c) => c.tag === x!.tag);
    parts.unshift(`${x.tag}:nth-of-type(${same.indexOf(x) + 1})`);
  }
  return parts.join(" > ");
}

/** Инвентарь интерактивных элементов: форма ответа как у window.__tg.inspect. */
export function inspectPage(page: Page, title: string, query: string, cap: number): Record<string, unknown> {
  const lim = cap > 0 ? cap : 80;
  const q = query.toLowerCase();
  const elements: Array<Record<string, unknown>> = [];
  let truncated = false;
  walk(page.root, (n) => {
    if (truncated || !isInteractive(n) || !isVisible(n)) return;
    const role = n.attrs.role || n.tag;
    const aria = n.attrs["aria-label"] ?? "";
    const text = oneLine(innerText(n) || n.attrs.value || n.attrs.title || "").slice(0, 80);
    if (q && !`${text} ${aria} ${role}`.toLowerCase().includes(q)) return;
    if (elements.length >= lim) return void (truncated = true);
    elements.push({ idx: elements.length, tag: n.tag, role, text, aria: aria.slice(0, 80) || null, selector: selFor(n), disabled: "disabled" in n.attrs || n.attrs["aria-disabled"] === "true", href: n.tag === "a" ? (n.attrs.href ?? null) : null });
  });
  return { url: page.url, title, count: elements.length, truncated, elements };
}

/** Цель: selector (первый видимый) или text (лучший балл подписи; ничья → самый вложенный). Не нашёл — not_found. */
export function target(page: Page, p: Record<string, unknown>, what: "any" | "field", label: unknown = p.text): DomNode {
  if (typeof p.selector === "string" && p.selector) {
    const hit = queryAll(page.root, p.selector).find(isVisible);
    if (!hit) throw new PageFail("not_found", `элемент «${p.selector.slice(0, 80)}» не найден — сделай web_inspect`, { pageCode: "not_found" });
    return hit;
  }
  const want = fold(label);
  if (!want) throw new PageFail("not_found", "укажи цель: selector или text", { pageCode: "not_found" });
  const top: { node?: DomNode; score: number } = { score: 0 };
  walk(page.root, (n) => {
    if (!isInteractive(n) || !isVisible(n) || (what === "field" && !editable(n))) return;
    const score = Math.max(0, ...labelParts(page.root, n).map((l) => scoreText(want, fold(l))));
    if (score > top.score || (score > 0 && score === top.score && top.node && contains(top.node, n))) Object.assign(top, { node: n, score });
  });
  if (!top.node) throw new PageFail("not_found", `не нашёл «${want.slice(0, 80)}» — сделай web_inspect`, { pageCode: "not_found" });
  return top.node;
}
export const contains = (a: DomNode, b: DomNode): boolean => {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
};
export function scoreText(q: string, hay: string): number {
  if (!q || !hay) return 0;
  if (hay === q) return 100;
  if (` ${hay} `.includes(` ${q} `)) return 80;
  if (q.length > 3 && hay.startsWith(q)) return 60;
  return q.length >= 4 && hay.includes(q) ? 30 : 0;
}
