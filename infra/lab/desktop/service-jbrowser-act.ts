/**
 * inspect / act невидимого браузера над DOM-моделью лаборатории. Контракт — тот же, что у page-функций расширения, которые
 * гоняет настоящий клиент (element-act.js / robust-click.js): строгая цель (нет — not_found, в фокус не печатаем), §0
 * secret_field (пароль/код/карта — только владелец), §14 commit_confirm по регэкспу `guard` от сервера (+ guardApproved и
 * approvedLabel после «да»). Отказ страницы — `PageFail` → denied/not_found/runtime с `data.pageCode`, как pageFailure().
 */
import { parseKeyCombo } from "@jarvis/shared";
import { type DomNode, find, innerText, isVisible, walk } from "./service-dom.js";
import { queryAll } from "./service-dom-select.js";

export class PageFail extends Error {
  constructor(readonly code: "not_found" | "denied" | "runtime", message: string, readonly data?: unknown, readonly injected = false) {
    super(message);
  }
}
export interface Page {
  url: string;
  root: DomNode;
  focused?: DomNode;
  scrollY: number;
}
/** Навигация из действия: страница или причина, почему перейти нельзя (внутренний адрес / нет в seed.web). */
export type Navigate = (url: string) => { page: Page } | { blocked: string } | { missing: string };

const fold = (s: unknown): string => String(s ?? "").toLowerCase().replace(/ё/gu, "е").replace(/[.,!?;:()"'«»\-—–]+/gu, " ").replace(/\s+/gu, " ").trim();
const oneLine = (s: string): string => s.replace(/\s+/gu, " ").trim();
const typeOf = (n: DomNode): string => (n.attrs.type ?? "").toLowerCase();
const SECRET = "secret_field: поле пароля/кода/карты — вводит владелец сам (§0), страница его не заполняет";

const isSecret = (n: DomNode): boolean => n.tag === "input" && (typeOf(n) === "password" || /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/iu.test(n.attrs.autocomplete ?? ""));
const editable = (n: DomNode): boolean => n.tag === "textarea" || n.attrs.contenteditable === "true" || (n.tag === "input" && !/^(checkbox|radio|submit|button|reset|image|file|hidden|range|color)$/u.test(typeOf(n)));
const formOf = (n: DomNode): DomNode | undefined => {
  for (let p: DomNode | undefined = n; p; p = p.parent) if (p.tag === "form") return p;
  return undefined;
};
const isSubmit = (n: DomNode): boolean => (n.tag === "button" && (typeOf(n) === "" || typeOf(n) === "submit")) || (n.tag === "input" && (typeOf(n) === "submit" || typeOf(n) === "image"));

const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "combobox"]);
export function isInteractive(n: DomNode): boolean {
  if (n.tag === "#text" || n.tag === "#root") return false;
  return (n.tag === "a" && "href" in n.attrs) || ["button", "input", "select", "textarea", "summary"].includes(n.tag) || INTERACTIVE_ROLES.has(n.attrs.role ?? "") || n.attrs.contenteditable === "true" || "onclick" in n.attrs || ("tabindex" in n.attrs && n.attrs.tabindex !== "-1") || "aria-label" in n.attrs;
}

/** Подписи элемента по отдельности (accname-подмножество): по ним ищут цель и судит гард §14. */
function labelParts(root: DomNode, n: DomNode): string[] {
  const parts = [n.attrs["aria-label"] ?? "", n.attrs.title ?? ""];
  const byFor = n.attrs.id ? find(root, (x) => x.tag === "label" && x.attrs.for === n.attrs.id) : undefined;
  if (byFor) parts.push(innerText(byFor));
  for (let p = n.parent; p; p = p.parent) if (p.tag === "label") parts.push(innerText(p));
  if (n.tag === "input" || n.tag === "textarea") {
    parts.push(n.attrs.placeholder ?? "");
    if (/^(submit|button|reset|image)$/u.test(typeOf(n))) parts.push(n.attrs.value ?? "", n.attrs.alt ?? "");
  } else if (n.tag !== "select") parts.push(innerText(n));
  return parts.map(oneLine).filter(Boolean);
}

/** CSS-селектор элемента — те же правила, что в page-скрипте inspect (стабильные атрибуты, иначе путь nth-of-type ≤ 4 уровней). */
function selFor(n: DomNode): string {
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
function target(page: Page, p: Record<string, unknown>, what: "any" | "field", label: unknown = p.text): DomNode {
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
const contains = (a: DomNode, b: DomNode): boolean => {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
};
function scoreText(q: string, hay: string): number {
  if (!q || !hay) return 0;
  if (hay === q) return 100;
  if (` ${hay} `.includes(` ${q} `)) return 80;
  if (q.length > 3 && hay.startsWith(q)) return 60;
  return q.length >= 4 && hay.includes(q) ? 30 : 0;
}

/** §14: подпись цели/формы под регэксп `guard` сервера без одобрения ровно этой подписи → commit_confirm. */
function guard(page: Page, p: Record<string, unknown>, t: DomNode, withForm: boolean): void {
  if (!p.guard) return;
  const re = new RegExp(String(p.guard), "iu");
  const form = withForm ? formOf(t) : undefined;
  const subs: DomNode[] = [];
  if (form) walk(form, (n) => void (isSubmit(n) && subs.push(n)));
  const parts = [...labelParts(page.root, t), ...subs.flatMap((s) => labelParts(page.root, s)), ...(form?.attrs["aria-label"] ? [form.attrs["aria-label"]] : [])];
  const shown = parts.find((x) => re.test(x));
  if (shown === undefined) return;
  const a = fold(p.approvedLabel);
  if (p.guardApproved === true && a && parts.some((x) => fold(x) === a)) return;
  throw new PageFail("denied", `commit_confirm: ${shown}`, { pageCode: "commit_confirm", label: shown });
}

/** Отправка формы: поля с name → журнал (секреты скрыты), переход на action, если страница есть в seed.web. */
function submit(form: DomNode, page: Page, nav: Navigate, log: (k: string, d: Record<string, unknown>) => void): Record<string, unknown> {
  const fields: Record<string, string> = {};
  walk(form, (n) => {
    if (n.tag === "#text" || !n.attrs.name || !["input", "textarea", "select"].includes(n.tag) || /^(submit|button|image|file)$/u.test(typeOf(n))) return;
    if (/^(checkbox|radio)$/u.test(typeOf(n)) && !("checked" in n.attrs)) return;
    fields[n.attrs.name] = isSecret(n) ? "***" : (n.attrs.value ?? "");
  });
  const action = new URL(form.attrs.action || page.url, page.url).href;
  log("jbrowser.submit", { url: action, method: (form.attrs.method || "get").toLowerCase(), fields });
  const r = nav(action);
  if ("page" in r) return { ok: true, submitted: true, navigated: r.page.url };
  return { ok: true, submitted: true, uncertain: true, note: `форма отправлена, но результат не наблюдаем: ${"blocked" in r ? r.blocked : r.missing}` };
}

/** Что действию нужно от браузера-хозяина: навигация, журнал эффектов, проверка файла для upload. */
export interface ActEnv {
  nav: Navigate;
  log: (kind: string, detail: Record<string, unknown>) => void;
  /** Файл для загрузки: {abs,size} или текст отказа (нет файла / секрет §0). */
  file: (path: string) => { abs: string; size: number } | string;
}

export function actOnPage(page: Page, env: ActEnv, intent: string, p: Record<string, unknown>): Record<string, unknown> {
  const { nav, log } = env;
  const pressEnter = (t: DomNode): Record<string, unknown> => {
    const form = formOf(t);
    if (form && (t.tag !== "input" || /^(text|search|email|tel|url|number|password|)$/u.test(typeOf(t)))) return submit(form, page, nav, log);
    return { submitted: false };
  };
  if (intent === "scroll") {
    page.scrollY = Math.max(0, page.scrollY + (Number(p.dy) || 600));
    return { ok: true };
  }
  if (intent === "click") {
    if (!p.selector && !p.text) throw new PageFail("not_found", "укажи цель: selector или text", { pageCode: "not_found" });
    const t = target(page, p, "any");
    guard(page, p, t, false);
    if ("disabled" in t.attrs || t.attrs["aria-disabled"] === "true") throw new PageFail("runtime", "элемент недоступен (disabled)");
    const label = labelParts(page.root, t)[0] ?? selFor(t);
    log("jbrowser.click", { selector: selFor(t), label });
    if (t.tag === "a" && t.attrs.href) {
      if (/^\s*javascript:/iu.test(t.attrs.href)) return { ok: true, clicked: label };
      const r = nav(new URL(t.attrs.href, page.url).href);
      if ("page" in r) return { ok: true, clicked: label, navigated: r.page.url };
      if ("blocked" in r) return { ok: true, clicked: label, blockedNav: r.blocked, blockedNavReason: "private" };
      throw new PageFail("not_found", `переход по ссылке не удался: ${r.missing}`, undefined, true); // клик ушёл, страницы нет
    }
    if (/^(checkbox|radio)$/u.test(typeOf(t))) {
      if ("checked" in t.attrs && typeOf(t) === "checkbox") delete t.attrs.checked;
      else t.attrs.checked = "";
      return { ok: true, clicked: label };
    }
    const form = formOf(t);
    if (form && isSubmit(t)) return { clicked: label, ...submit(form, page, nav, log) };
    if (editable(t)) page.focused = t;
    return { ok: true, clicked: label };
  }
  if (intent === "type") {
    // text при type — СОДЕРЖИМОЕ ввода; цель задают selector или label (как у element-act.js)
    let t = p.selector || p.label ? target(page, p, p.selector ? "any" : "field", p.label) : (page.focused ?? find(page.root, (n) => editable(n) && isVisible(n)));
    if (!t) throw new PageFail("not_found", "поле ввода не найдено — сделай web_inspect", { pageCode: "not_found" });
    if (!editable(t)) t = find(t, (n) => n !== t && editable(n) && isVisible(n) && !isSecret(n)) ?? t;
    if (isSecret(t)) throw new PageFail("denied", SECRET, { pageCode: "secret_field" });
    if (!editable(t)) throw new PageFail("runtime", "элемент не поле ввода — для кнопки click, для галочки/списка set");
    const enter = p.enter === true || p.submit === true;
    if (enter) guard(page, p, t, true);
    t.attrs.value = String(p.text ?? "");
    page.focused = t;
    log("jbrowser.type", { selector: selFor(t), chars: t.attrs.value.length });
    return { ok: true, value: t.attrs.value.slice(0, 60), ...(enter ? pressEnter(t) : { submitted: false }) };
  }
  if (intent === "key") {
    const combo = String(p.combo ?? p.key ?? "Enter");
    const k = parseKeyCombo(combo);
    if (!k) throw new PageFail("runtime", `key: не понял клавишу «${combo.slice(0, 30)}» — одна клавиша плюс модификаторы; ничего не нажимал`, { pageCode: "invalid_combo" });
    const t = p.selector ? target(page, p, "any") : page.focused;
    if (k.key !== "enter") {
      log("jbrowser.key", { combo });
      return { ok: true, sent: combo, note: "синтетическая клавиша: обработчики страницы её получили, но браузер сам её действие не выполняет" };
    }
    if (!t) throw new PageFail("not_found", "нет сфокусированного поля для Enter. Объедини ввод и отправку: type + enter:true, либо передай selector.", { pageCode: "not_found" });
    guard(page, p, t, true); // любой Enter (и с модификаторами) — гард цели и формы
    log("jbrowser.key", { combo });
    return { ok: true, sent: combo, ...(k.ctrl || k.alt || k.meta || k.shift ? {} : pressEnter(t)) };
  }
  if (intent === "upload") {
    const path = String(p.path ?? "").trim();
    if (!path) throw new PageFail("runtime", "upload: нужен params.path (файл на диске)");
    const f = env.file(path);
    if (typeof f === "string") throw new PageFail("runtime", f);
    const selector = String(p.selector ?? "input[type=file]");
    if (!queryAll(page.root, selector).length) throw new PageFail("not_found", `upload: элемент «${selector}» не найден — сначала открой форму загрузки`);
    log("jbrowser.upload", { path: f.abs, selector, bytes: f.size });
    return { ok: true, note: `upload ${f.abs.split("/").pop()} (${Math.round(f.size / 1024)} КБ) в ${selector}` };
  }
  throw new PageFail("runtime", `web_act: неизвестный intent «${intent}»`);
}
