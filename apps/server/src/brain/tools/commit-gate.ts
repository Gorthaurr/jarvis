/**
 * §14 ГЕЙТ НЕОБРАТИМЫХ КЛИКОВ в вебе и GUI (причина №4 из USER_SCENARIOS_2026-09-02).
 *
 * До этого кодовый confirm стоял только у telegram_send/message_send/order_place/fs_delete/system_power —
 * а «Опубликовать» в YouTube Studio, «Оплатить» на маркетплейсе, «Провести» в 1С, «Подписать» в ЭДО и Enter в
 * WhatsApp/Discord уходили одним browser_act/ui_invoke/input_key БЕЗ вопроса владельцу: держалось лишь прозой
 * персоны и рецептов. Prompt-инъекция со страницы обходила прозу одним вызовом.
 *
 * Принцип: гейтим ПЕРЕСЕЧЕНИЕ «опасное место» × «действие-коммит». Опасное место — хост/процесс из списков
 * ниже (банк, платежи, ЭДО, госуслуги, маркетплейс, соцсеть, мессенджер). Коммит — Enter/submit/type+enter
 * ИЛИ клик по элементу, чьё имя похоже на глагол публикации/оплаты/отправки. Клик по координатам и
 * безымянный селектор судить нельзя — они НЕ гейтятся (осознанный предел; ложно-положительные срабатывания
 * стоят один вопрос, ложно-отрицательные — необратимый дубль). Чистый модуль, списки — данные.
 */

import { COMMIT_WORDS_RE, type RiskCategory, riskyAppCategory, riskyProcessCategory } from "@jarvis/shared";
import { LMS_COMMIT_RE, isLmsPage, lmsKeyCommits } from "./commit-lms.js";

export type { RiskCategory };
// W0: список процессов и riskyProcessCategory переехали в @jarvis/shared/commit-risk — их же читает
// клиентский рубеж (SDK-мост, реплей навыка). Реэкспорт — для прежних потребителей.
export { riskyProcessCategory };

const CATEGORY_HUMAN: Record<RiskCategory, string> = {
  bank: "банк",
  payment: "платёжный сервис",
  edo: "ЭДО/подпись",
  gov: "госуслуги",
  market: "маркетплейс/магазин",
  social: "публичная площадка",
  messenger: "мессенджер/почта",
  edu: "учебная система — тест/задание",
  unknown: "сайт вкладки не определён",
};

/** Хосты (суффиксы) → категория. Расширять строкой; порядок не важен. */
const RISKY_HOSTS: ReadonlyArray<readonly [string, RiskCategory]> = [
  ["sberbank.ru", "bank"], ["sber.ru", "bank"], ["tinkoff.ru", "bank"], ["tbank.ru", "bank"], ["alfabank.ru", "bank"],
  ["vtb.ru", "bank"], ["raiffeisen.ru", "bank"], ["gazprombank.ru", "bank"], ["psbank.ru", "bank"], ["sovcombank.ru", "bank"],
  ["open.ru", "bank"], ["rosbank.ru", "bank"], ["pochtabank.ru", "bank"], ["mtsbank.ru", "bank"], ["ozon.bank", "bank"],
  ["yoomoney.ru", "payment"], ["qiwi.com", "payment"], ["pay.yandex.ru", "payment"], ["cloudpayments.ru", "payment"],
  ["paypal.com", "payment"], ["stripe.com", "payment"],
  ["diadoc.kontur.ru", "edo"], ["kontur.ru", "edo"], ["sbis.ru", "edo"], ["taxcom.ru", "edo"],
  ["nalog.gov.ru", "gov"], ["nalog.ru", "gov"], ["gosuslugi.ru", "gov"], ["mos.ru", "gov"],
  ["ozon.ru", "market"], ["wildberries.ru", "market"], ["market.yandex.ru", "market"], ["aliexpress.ru", "market"],
  ["aliexpress.com", "market"], ["avito.ru", "market"], ["lamoda.ru", "market"], ["dns-shop.ru", "market"], ["mvideo.ru", "market"],
  ["citilink.ru", "market"], ["sbermegamarket.ru", "market"], ["megamarket.ru", "market"],
  ["youtube.com", "social"], ["vk.com", "social"], ["instagram.com", "social"], ["tiktok.com", "social"], ["dzen.ru", "social"],
  ["twitch.tv", "social"], ["x.com", "social"], ["twitter.com", "social"], ["facebook.com", "social"], ["t.me", "social"],
  ["pikabu.ru", "social"], ["habr.com", "social"], ["boosty.to", "social"],
  ["web.telegram.org", "messenger"], ["web.whatsapp.com", "messenger"], ["discord.com", "messenger"], ["teams.microsoft.com", "messenger"],
  ["slack.com", "messenger"], ["mail.google.com", "messenger"], ["mail.yandex.ru", "messenger"], ["e.mail.ru", "messenger"],
  ["outlook.live.com", "messenger"], ["outlook.office.com", "messenger"], ["max.ru", "messenger"],
];

// W4: COMMIT_WORDS_RE живёт в @jarvis/shared/commit-risk (один список на сервер и клиентский рубеж act); реэкспорт.
export { COMMIT_WORDS_RE };

export interface CommitRisk {
  category: RiskCategory;
  /** Где: хост или процесс. */
  where: string;
  /** Что именно: «клик «Опубликовать»», «Enter (отправка сообщения)». */
  what: string;
  /** Готовая строка для модалки подтверждения. */
  summary: string;
}

export function riskyHostCategory(host: string): RiskCategory | null {
  const h = host.trim().toLowerCase().replace(/^www\./u, "");
  if (!h) return null;
  for (const [suffix, cat] of RISKY_HOSTS) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return cat;
  }
  return null;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Веб: browser_act / browser_batch / web_act. `label` — подпись элемента, если известна (ref-хинт из
 * последнего browser_inspect). Коммит = enter/submit/type+enter либо клик по элементу с глаголом коммита.
 */
export function assessWebCommit(a: {
  host: string;
  /** Полный адрес страницы — LMS узнаётся по пути (хост у каждого вуза свой). */
  url?: string;
  /** Адрес вкладки определить не удалось (действие по tabId без url) — судим строго, как опасное место. */
  unknownSite?: boolean;
  intent: string;
  params?: Record<string, unknown>;
  label?: string;
}): CommitRisk | null {
  const url = a.url ?? "";
  const category: RiskCategory | null = riskyHostCategory(a.host) ?? (isLmsPage(url) ? "edu" : a.unknownSite ? "unknown" : null);
  if (!category) return null;
  const p = a.params ?? {};
  const intent = a.intent.trim().toLowerCase();
  const parts = [p.text, p.name, p.title, a.label].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  const text = parts.join(" ");
  // Ревью 26.09: type{submit:true} постит так же, как enter:true; web_act{key} без key — это Enter (jarvis-browser.ts).
  const keyEnter = intent === "key" && /^(?:enter|return)?$/iu.test(String(p.key ?? p.combo ?? "").trim());
  const commitByKey =
    (intent === "enter" || intent === "submit" || keyEnter || (intent === "type" && (truthy(p.enter) || truthy(p.submit)))) &&
    (category !== "edu" || lmsKeyCommits(url));
  const lmsWords = category === "edu" || category === "unknown"; // неизвестная вкладка может оказаться учебной
  const commitByClick = intent === "click" && (COMMIT_WORDS_RE.test(text) || (lmsWords && parts.some((s) => LMS_COMMIT_RE.test(s))));
  if (!commitByKey && !commitByClick) return null;
  const what = commitByKey
    ? category === "messenger"
      ? "Enter — отправка сообщения"
      : "Enter/submit — отправка формы"
    : `клик «${text.trim().slice(0, 60)}»`;
  const where = a.host.toLowerCase().replace(/^www\./u, "") || "неизвестной вкладке";
  return { category, where, what, summary: `Необратимое действие в браузере (${CATEGORY_HUMAN[category]}): ${what} на ${where}.` };
}

/** «На переднем плане: <process> «title»» из живого снимка client.system (sensors/system-snapshot.ts). */
export function parseForegroundProcess(systemContext: string): string | null {
  const m = /На переднем плане:\s*([^\s«(·]+)/u.exec(systemContext);
  return m ? m[1]! : null;
}

/**
 * GUI: ui_invoke / input_key / input_click в опасном ПРОЦЕССЕ на переднем плане. `label` — имя элемента
 * (для ui_invoke — из последнего ui_snapshot по handle). Координатный клик судить нельзя → не гейтится.
 */
export function assessGuiCommit(a: {
  foregroundProcess: string | null;
  /** act{app}: окно, которое act сам сфокусирует — судим по НЕМУ (нестрого: «дискорд», «Telegram Desktop»). */
  app?: string | null;
  tool: "ui_invoke" | "input_key" | "input_click" | "act" | "input_type";
  input: Record<string, unknown>;
  label?: string;
}): CommitRisk | null {
  const name = a.app?.trim() ? a.app.trim() : a.foregroundProcess;
  if (!name) return null;
  const proc = a.app?.trim() ? riskyAppCategory(name) : riskyProcessCategory(name);
  if (!proc) return null;
  const where = `${name} (${proc.human})`;
  const mk = (what: string): CommitRisk => ({
    category: proc.category,
    where,
    what,
    summary: `Необратимое действие в программе ${where}: ${what}.`,
  });
  // Ревью 2026-09-24: перевод строки в печатаемом тексте — это Enter (синтетический \r/\n мессенджер читает как
  // «отправить»). «act{do:"type", text:"привет\n"}» в Telegram уходил человеку МИМО вопроса владельца.
  // Контроль-2: в ПОЧТОВОМ клиенте перевод строки — новый абзац письма, отправка там — кнопкой (судится отдельно).
  const typedNewline = (t: unknown): boolean => proc.human !== "почта" && typeof t === "string" && /[\r\n]/u.test(t);
  if (a.tool === "input_type") {
    return typedNewline(a.input.text) ? mk(proc.category === "messenger" ? "печать с переводом строки — Enter отправит сообщение" : "печать с переводом строки — Enter подтвердит") : null;
  }
  if (a.tool === "input_key") {
    // Ревью 2026-09-24: поле схемы input_key — `combo`. Гейт читал `key`, которого модель не шлёт, и Enter в мессенджере
    // уходил БЕЗ вопроса владельцу (тесты кормили тем же неверным полем — фикстура била мимо). `key` оставлен как синоним.
    const key = String(a.input.combo ?? a.input.key ?? "").toLowerCase();
    const mode = String(a.input.mode ?? "");
    if (/enter|return/u.test(key) && mode !== "up") return mk(proc.category === "messenger" ? "Enter — отправка сообщения" : "Enter — подтверждение/проведение");
    return null;
  }
  // W4 «Руки»: act do:key «Enter» ≡ input_key; act click/double по тексту-коммиту ≡ клик по подписи. Печать/set/
  // toggle сами ничего не отправляют — не судятся (как у input_type).
  if (a.tool === "act") {
    const verb = String(a.input.do ?? "click");
    if (verb === "key") {
      const combo = String(a.input.combo ?? "").toLowerCase();
      return /enter|return/u.test(combo) ? mk(proc.category === "messenger" ? "Enter — отправка сообщения" : "Enter — подтверждение/проведение") : null;
    }
    if (verb === "type" && typedNewline(a.input.text)) {
      return mk(proc.category === "messenger" ? "печать с переводом строки — Enter отправит сообщение" : "печать с переводом строки — Enter подтвердит");
    }
    if (verb !== "click" && verb !== "double") return null;
    const t = a.input.target;
    const own = typeof t === "string" ? t : t && typeof t === "object" ? String((t as { text?: unknown }).text ?? "") : "";
    // H-S1: цель по handle судится подписью элемента из последнего снапшота (label) — иначе «Отправить» по handle шло мимо гейта.
    const text = own.trim() ? own : (a.label ?? "");
    return text && COMMIT_WORDS_RE.test(text) ? mk(`клик «${text.trim().slice(0, 60)}»`) : null;
  }
  const target = (a.input.target && typeof a.input.target === "object" ? (a.input.target as Record<string, unknown>) : {}) as Record<string, unknown>;
  const text = [a.label, a.input.name, a.input.text, target.text, target.name, target.query]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ");
  if (!text || !COMMIT_WORDS_RE.test(text)) return null;
  return mk(`${a.tool === "ui_invoke" ? "вызов" : "клик"} «${text.trim().slice(0, 60)}»`);
}

// ── Память сессии: подписи UIA-элементов по handle (для ui_invoke) и последняя цель web_open (для web_act) ──

const uiHandles = new WeakMap<object, Map<number, string>>();
const UI_HANDLES_MAX = 400;

/** Запомнить handle→имя из результата ui_snapshot ({items:[{handle,name,role}]}). Подписи — данные страницы/окна:
 *  используются ТОЛЬКО в сторону «похоже на коммит → спросить» (враждебная подпись даст лишний вопрос, не утечку). */
export function rememberUiHandles(session: object | undefined, data: unknown): void {
  if (!session || !data || typeof data !== "object") return;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return;
  const map = new Map<number, string>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as { handle?: unknown; name?: unknown; role?: unknown };
    if (typeof it.handle !== "number") continue;
    const name = [it.name, it.role].filter((v): v is string => typeof v === "string" && v.length > 0).join(" ");
    if (name) map.set(it.handle, name.slice(0, 160));
    if (map.size >= UI_HANDLES_MAX) break;
  }
  uiHandles.set(session, map);
}

export function uiHandleLabel(session: object | undefined, handle: unknown): string | undefined {
  if (!session || typeof handle !== "number") return undefined;
  return uiHandles.get(session)?.get(handle);
}

const webTargets = new WeakMap<object, string>();
export function rememberWebTarget(session: object | undefined, url: string): void {
  if (session && url) webTargets.set(session, url);
}
export function lastWebTarget(session: object | undefined): string {
  return (session && webTargets.get(session)) ?? "";
}

/** Хост из URL/голого хоста (без схемы) — для гейта; непарсящееся → "". */
export function hostOfUrl(url: string): string {
  const s = url.trim();
  if (!s) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(s) ? s : `https://${s}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}
