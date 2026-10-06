import { selFor, target } from "./service-jbrowser-target.js";
import { type Navigate, type Page, PageFail, SECRET, editable, fold, formOf, isSecret, isSubmit, labelParts, typeOf } from "./service-page.js";
export { inspectPage } from "./service-jbrowser-target.js";
export { PageFail,isInteractive,type Navigate,type Page } from "./service-page.js";
/**
 * inspect / act невидимого браузера над DOM-моделью лаборатории. Контракт — тот же, что у page-функций расширения, которые
 * гоняет настоящий клиент (element-act.js / robust-click.js): строгая цель (нет — not_found, в фокус не печатаем), §0
 * secret_field (пароль/код/карта — только владелец), §14 commit_confirm по регэкспу `guard` от сервера (+ guardApproved и
 * approvedLabel после «да»). Отказ страницы — `PageFail` → denied/not_found/runtime с `data.pageCode`, как pageFailure().
 */
import { parseKeyCombo } from "@jarvis/shared";
import { queryAll } from "./service-dom-select.js";
import { type DomNode, find, isVisible, walk } from "./service-dom.js";

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
