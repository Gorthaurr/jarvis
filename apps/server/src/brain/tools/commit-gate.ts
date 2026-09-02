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

export type RiskCategory = "bank" | "payment" | "edo" | "gov" | "market" | "social" | "messenger";

const CATEGORY_HUMAN: Record<RiskCategory, string> = {
  bank: "банк",
  payment: "платёжный сервис",
  edo: "ЭДО/подпись",
  gov: "госуслуги",
  market: "маркетплейс/магазин",
  social: "публичная площадка",
  messenger: "мессенджер/почта",
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

/** Процессы настольных программ (имя без .exe, регистр не важен) → категория. */
const RISKY_PROCESSES: ReadonlyArray<readonly [RegExp, RiskCategory, string]> = [
  [/^1cv8/i, "edo", "1С"],
  [/sbbol|ibank|bankclient|client-?bank|interbank|isfront|bss\b/i, "bank", "банк-клиент"],
  [/cryptopro|cryptoarm|vipnet|signtool/i, "edo", "подпись"],
  [/^(telegram|discord|whatsapp|viber|slack|teams|zoom|max)$/i, "messenger", "мессенджер"],
  [/^(outlook|thunderbird|thebat)/i, "messenger", "почта"],
];

/**
 * Глаголы коммита — «опубликовать/отправить/оплатить/подтвердить/провести/подписать/купить/оформить/перевести»
 * и их английские пары. Ловит и «подписаться» (лишний вопрос на YouTube — безопасная сторона).
 */
export const COMMIT_WORDS_RE =
  /(?<![\p{L}])(?:опубликов|разместит|размести|отправ|оплат|заплат|подтвер|провест|провед|подпис|купит|оформ|заказат|перевес|перевод|разослат|publish|post\b|send\b|pay\b|confirm|submit|buy\b|checkout|place order|transfer|sign\b|approve)/iu;

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

export function riskyProcessCategory(processName: string): { category: RiskCategory; human: string } | null {
  const p = processName.trim().replace(/\.exe$/iu, "");
  if (!p) return null;
  for (const [re, category, human] of RISKY_PROCESSES) if (re.test(p)) return { category, human };
  return null;
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Веб: browser_act / browser_batch / web_act. `label` — подпись элемента, если известна (ref-хинт из
 * последнего browser_inspect). Коммит = enter/submit/type+enter либо клик по элементу с глаголом коммита.
 */
export function assessWebCommit(a: { host: string; intent: string; params?: Record<string, unknown>; label?: string }): CommitRisk | null {
  const category = riskyHostCategory(a.host);
  if (!category) return null;
  const p = a.params ?? {};
  const intent = a.intent.trim().toLowerCase();
  const text = [p.text, p.name, p.title, a.label].filter((v): v is string => typeof v === "string" && v.trim().length > 0).join(" ");
  const commitByKey = intent === "enter" || intent === "submit" || (intent === "type" && truthy(p.enter));
  const commitByClick = intent === "click" && COMMIT_WORDS_RE.test(text);
  if (!commitByKey && !commitByClick) return null;
  const what = commitByKey
    ? category === "messenger"
      ? "Enter — отправка сообщения"
      : "Enter/submit — отправка формы"
    : `клик «${text.trim().slice(0, 60)}»`;
  const where = a.host.toLowerCase().replace(/^www\./u, "");
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
  tool: "ui_invoke" | "input_key" | "input_click";
  input: Record<string, unknown>;
  label?: string;
}): CommitRisk | null {
  if (!a.foregroundProcess) return null;
  const proc = riskyProcessCategory(a.foregroundProcess);
  if (!proc) return null;
  const where = `${a.foregroundProcess} (${proc.human})`;
  const mk = (what: string): CommitRisk => ({
    category: proc.category,
    where,
    what,
    summary: `Необратимое действие в программе ${where}: ${what}.`,
  });
  if (a.tool === "input_key") {
    const key = String(a.input.key ?? "").toLowerCase();
    const mode = String(a.input.mode ?? "");
    if (/enter|return/u.test(key) && mode !== "up") return mk(proc.category === "messenger" ? "Enter — отправка сообщения" : "Enter — подтверждение/проведение");
    return null;
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
