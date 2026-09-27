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

import { COMMIT_WORDS_RE, type RiskCategory, isCommitKeyCombo, isOnFlag, riskyProcessCategory } from "@jarvis/shared";
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

/**
 * Подпись элемента, по которой судим клик (W1-2): text/name/title модели + подпись ref из снимка. У type `text` — это
 * ПЕЧАТАЕМОЕ, а не подпись: для подписи одобрения (approvedLabel) его не берём (см. commitApprovalLabel).
 */
export function webCommitLabelParts(intent: string, p: Record<string, unknown>, label?: string): string[] {
  const own = intent.trim() === "type" ? [p.label, p.name, p.title] : [p.text, p.name, p.title];
  return [...own, label].filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
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
  const parts = intent === "click" ? webCommitLabelParts(intent, p, a.label) : [];
  const text = parts.join(" ");
  // Ревью 26.09: type{submit:true} постит так же, как enter:true; web_act{key} без key — это Enter (jarvis-browser.ts).
  // W1: browser_act{key, combo} — Ctrl+Enter/Shift+Enter отправляют в мессенджерах так же, как Enter (общий с GUI-гейтом
  // и клиентским рубежом isCommitKeyCombo). Пустая клавиша — Enter (web_act{key} без key).
  const combo = String(p.combo ?? p.key ?? "").trim();
  const keyEnter = intent === "key" && (combo === "" || isCommitKeyCombo(combo));
  // W1-ревью р2 (srv-bypass-5): встряхивание (shake, клик «обновить…») расширение досылает Enter-фолбэком — в
  // мессенджере это возможная отправка. Основы — зеркало isShake в tabAct расширения.
  const shakeEnter = category === "messenger" && (intent === "shake" || (intent === "click" && /встрях|стряхн|обнов/iu.test(String(p.text ?? ""))));
  const commitByKey =
    (intent === "enter" || intent === "submit" || keyEnter || shakeEnter || (intent === "type" && (isOnFlag(p.enter) || isOnFlag(p.submit)))) &&
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

// W2 (П3): суд GUI-коммитов по запросу — gui-intents.ts/gui-gate.ts (подписи и процесс из shared, гранты); память
// handle → имя/роль/секрет — gate-memory.ts. Реэкспорт — для прежних потребителей (dispatch запоминает снимки).
export { rememberUiHandles, uiHandleLabel } from "./gate-memory.js";

/** Человеческое имя категории риска — для текста вопроса владельцу (веб и браузер через GUI). */
export function categoryHuman(c: RiskCategory): string {
  return CATEGORY_HUMAN[c];
}

// ── Память сессии: последняя цель web_open (для web_act) ──

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
