/**
 * W0 (2026-09-09): ОБЩИЕ ДАННЫЕ §14-гейта необратимых коммитов — один список для сервера
 * (`brain/tools/commit-gate.ts`) и клиента (`actuators/commit-guard.ts`).
 *
 * Зачем на клиенте: серверный гейт стоит только в `dispatchTool`, а SDK-мост (`act-bridge`) и реплей
 * навыка (`skill-runner/client-actuator`) зовут клиентские актуаторы НАПРЯМУЮ — prompt-injected
 * python-скрипт (`jarvis.key("enter")` при Telegram на переднем плане) или отравленный шаг навыка
 * коммитили отправку без единого вопроса владельцу. Списки — данные; расширять строкой.
 */

import { comboMentionsEnter } from "./key-combo.js";

// edu — учебная LMS (тест/задание, 26.09); unknown — сайт вкладки не удалось определить (судим строго, fail-closed).
export type RiskCategory = "bank" | "payment" | "edo" | "gov" | "market" | "social" | "messenger" | "edu" | "unknown";

/** Процессы настольных программ (имя без .exe, регистр не важен) → категория + человеко-метка. */
export const RISKY_PROCESSES: ReadonlyArray<readonly [RegExp, RiskCategory, string]> = [
  [/^1cv8/i, "edo", "1С"],
  [/sbbol|ibank|bankclient|client-?bank|interbank|isfront|bss\b/i, "bank", "банк-клиент"],
  [/cryptopro|cryptoarm|vipnet|signtool/i, "edo", "подпись"],
  // W2: + ms-teams (новые Teams), signal, skype, VK Teams, element.
  [/^(telegram|discord|whatsapp|viber|slack|teams|ms-teams|zoom|max|signal|skype|vk ?teams|element)$/i, "messenger", "мессенджер"],
  // W2: + olk (новый Outlook), hxoutlook (Почта Windows).
  [/^(outlook|olk|hxoutlook|thunderbird|thebat)/i, "messenger", "почта"],
];

export function riskyProcessCategory(processName: string): { category: RiskCategory; human: string } | null {
  const p = processName.trim().replace(/\.exe$/iu, "");
  if (!p) return null;
  for (const [re, category, human] of RISKY_PROCESSES) if (re.test(p)) return { category, human };
  return null;
}

/** Русские/разговорные имена программ → имя процесса (то, что понимает RISKY_PROCESSES). */
const APP_NAME_ALIASES: Record<string, string> = {
  телеграм: "telegram",
  телеграмм: "telegram",
  телега: "telegram",
  тг: "telegram",
  дискорд: "discord",
  дис: "discord",
  ватсап: "whatsapp",
  вотсап: "whatsapp",
  вацап: "whatsapp",
  вайбер: "viber",
  слак: "slack",
  тимс: "teams",
  зум: "zoom",
  аутлук: "outlook",
  сигнал: "signal",
  скайп: "skype",
  "1с": "1cv8",
};

/** Слова, которые — и мессенджеры, и части чужих названий («3ds Max», «Zoom Player»): их — только целым именем. */
const AMBIGUOUS_WORDS: ReadonlySet<string> = new Set(["max", "zoom"]);

/**
 * Кандидаты имени процесса из свободной строки модели (`app`) или заголовка: вся строка, слитно, каждое слово
 * (кроме неоднозначных); русские имена — через алиасы. Общая база `riskyAppCategory` и `canonicalProcess` (W2).
 */
export function appNameCandidates(app: string): string[] {
  const s = String(app ?? "").trim().toLowerCase().replace(/\.exe$/u, "");
  if (!s) return [];
  // Слова — и по любому разделителю, и с дефисом внутри («ms-teams»).
  const words = [...s.split(/[^\p{L}\p{N}]+/u), ...s.split(/[^\p{L}\p{N}-]+/u)].filter((w) => w && !AMBIGUOUS_WORDS.has(w));
  return [...new Set([s, s.replace(/[^\p{L}\p{N}]+/gu, ""), ...words])].map((c) => APP_NAME_ALIASES[c] ?? c);
}

/**
 * Ревью 2026-09-24: `act{app}` судится по ИМЕНИ из `app`, а не по переднему плану (act сам фокусирует это окно). Но
 * `app` — свободная строка модели: «дискорд», «Telegram Desktop» окно находили (алиасы / подстрока заголовка), а
 * якорный `^(telegram|discord…)$` их не узнавал — и Enter/«Отправить» уходил человеку без вопроса владельцу.
 * Нестрого: вся строка, каждое слово, русские имена. Ложное срабатывание стоит одного лишнего вопроса.
 */
export function riskyAppCategory(app: string): { category: RiskCategory; human: string } | null {
  for (const cand of appNameCandidates(app)) {
    const hit = riskyProcessCategory(cand);
    if (hit) return hit;
  }
  return null;
}

/** W2: удалённый доступ и ВМ — внутрь сессии UIA не видит, поэтому судятся только клавиши (решение №7). */
export const REMOTE_PROCESSES: RegExp = /^(mstsc|vmconnect|virtualboxvm|vmware.*|vmplayer|anydesk|teamviewer|rustdesk)$/i;
/** W2: браузеры — GUI-действия в них судятся как категория web (вкладка по tabList на сервере). browser — Яндекс. */
export const BROWSER_PROCESSES: RegExp = /^(chrome|msedge|firefox|opera|brave|browser|vivaldi)$/i;

export type GuiCategory = RiskCategory | "web" | "remote";

/**
 * W2: категория GUI-процесса для рубежа §14. Рискованный → его категория; удалённый доступ/ВМ → "remote"; браузер →
 * "web"; ApplicationFrameHost (UWP-хост: Почта Windows) или процесс неизвестен → по заголовку окна. Прочее → null.
 */
export function guiProcessCategory(process: string | null | undefined, title?: string): { category: GuiCategory; human: string } | null {
  const p = String(process ?? "").trim().replace(/\.exe$/iu, "");
  if (!p || /^applicationframehost$/i.test(p)) return title ? riskyAppCategory(title) : null;
  const risky = riskyProcessCategory(p);
  if (risky) return risky;
  if (REMOTE_PROCESSES.test(p)) return { category: "remote", human: "удалённый доступ" };
  if (BROWSER_PROCESSES.test(p)) return { category: "web", human: "браузер" };
  return null;
}

/**
 * Клавиша-коммит: основная клавиша Enter/Return с ЛЮБЫМИ модификаторами (Ctrl+Enter — «отправить» в Telegram/Discord/
 * почте, Alt/Meta/Cmd+Enter — в части клиентов; Shift+Enter где-то перенос строки, где-то отправка — считаем коммитом
 * консервативно) и в любом порядке («Enter+Ctrl»). Разбор — общий с расширением (key-combo.ts); недействительная
 * строка с Enter («a+Enter», «Enter+Enter») — тоже коммит: старое расширение нажало бы в ней Enter (W1-ревью р2).
 */
export function isCommitKeyCombo(combo: string): boolean {
  return comboMentionsEnter(combo);
}

/**
 * Глаголы коммита — «опубликовать/отправить/оплатить/подтвердить/провести/подписать/купить/оформить/перевести»
 * и их английские пары. Ловит и «подписаться» (лишний вопрос на YouTube — безопасная сторона).
 * W4: переехал сюда из серверного commit-gate — клиентский рубеж (act по тексту кнопки с SDK-моста) читает тот же список.
 * W1 (B-5): УДАЛЕНИЕ — тоже необратимое («Удалить навсегда» в почте/облаке уходило без вопроса): «удал…», «стереть»,
 * delete/erase. Не удаление: «удалённый/удаленный (рабочий стол, доступ)», «удалёнка», «удалось» — эти основы исключены;
 * «Deleted» (папка «Удалённые») — тоже. Ложный вопрос дешевле необратимого удаления, но mstsc спрашивать не должен.
 * W1-9: синонимы удаления — Remove, Move to trash/bin, «Переместить/перенести в корзину», Deactivate, Close account.
 * Голое «в корзину» НЕ берём: на любом магазине это «Добавить в корзину» (гард страницы стоит на ЛЮБОМ сайте) — вопрос
 * на каждую покупку; удаление в корзину звучит глаголом перемещения, а кнопка «Удалить» ловится основой «удал».
 * W1-ревью р2 (srv-bypass-6): заказ/покупка (Place your order, Purchase, Complete order, Order now), публичный
 * комментарий (Comment — голое: лишний вопрос дешевле публичного коммента; «Оставить комментарий»), очистка корзины/
 * папки (Empty trash, «Очистить корзину/папку»). «Добавить в корзину» по-прежнему НЕ ловим (тест).
 * ⚠️ Литерал — ОДНОЙ строкой `/…/iu;`: его исходник читает стенд расширения (apps/extension/test/cdp-harness.mjs).
 */
export const COMMIT_WORDS_RE =
  /(?<![\p{L}])(?:опубликов|разместит|размести|отправ|оплат|заплат|подтвер|провест|провед|подпис|купит|оформ|заказат|перевес|перевод|разослат|удал(?![её]нн|[её]нк|ось)|стерет|publish|post\b|send\b|pay\b|confirm|submit|buy\b|checkout|place\s+(?:your\s+)?order|purchas|complete\s+(?:order|purchase)|order\s+now|comment\b|оставит\p{L}*\s+коммент|transfer|sign\b|approve|delete(?!d)|erase\b|remove\b|to\s+(?:the\s+)?(?:trash|bin)\b|(?:перемест|перенес)\p{L}*\s+в\s+корзин|deactivate|close\s+account|empty\s+(?:the\s+)?trash|очист\p{L}*\s+(?:корзин|папк))/iu;

/**
 * Единое «включено» для флагов коммита (`enter`/`submit`) от LLM: true, 1, "true"/"1"/"yes"/"да". Сервер нормализует
 * по нему до отправки в расширение, гейт §14 и петля судят по нему же — три потребителя, одна правда (W1-ревью LOOP-3).
 */
export function isOnFlag(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === "string" && /^(true|1|yes|да)$/iu.test(v.trim());
}
