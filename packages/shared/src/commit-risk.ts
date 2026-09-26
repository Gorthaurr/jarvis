/**
 * W0 (2026-09-09): ОБЩИЕ ДАННЫЕ §14-гейта необратимых коммитов — один список для сервера
 * (`brain/tools/commit-gate.ts`) и клиента (`actuators/commit-guard.ts`).
 *
 * Зачем на клиенте: серверный гейт стоит только в `dispatchTool`, а SDK-мост (`act-bridge`) и реплей
 * навыка (`skill-runner/client-actuator`) зовут клиентские актуаторы НАПРЯМУЮ — prompt-injected
 * python-скрипт (`jarvis.key("enter")` при Telegram на переднем плане) или отравленный шаг навыка
 * коммитили отправку без единого вопроса владельцу. Списки — данные; расширять строкой.
 */

// edu — учебная LMS (тест/задание, 26.09); unknown — сайт вкладки не удалось определить (судим строго, fail-closed).
export type RiskCategory = "bank" | "payment" | "edo" | "gov" | "market" | "social" | "messenger" | "edu" | "unknown";

/** Процессы настольных программ (имя без .exe, регистр не важен) → категория + человеко-метка. */
export const RISKY_PROCESSES: ReadonlyArray<readonly [RegExp, RiskCategory, string]> = [
  [/^1cv8/i, "edo", "1С"],
  [/sbbol|ibank|bankclient|client-?bank|interbank|isfront|bss\b/i, "bank", "банк-клиент"],
  [/cryptopro|cryptoarm|vipnet|signtool/i, "edo", "подпись"],
  [/^(telegram|discord|whatsapp|viber|slack|teams|zoom|max)$/i, "messenger", "мессенджер"],
  [/^(outlook|thunderbird|thebat)/i, "messenger", "почта"],
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
  "1с": "1cv8",
};

/**
 * Ревью 2026-09-24: `act{app}` судится по ИМЕНИ из `app`, а не по переднему плану (act сам фокусирует это окно). Но
 * `app` — свободная строка модели: «дискорд», «Telegram Desktop» окно находили (алиасы / подстрока заголовка), а
 * якорный `^(telegram|discord…)$` их не узнавал — и Enter/«Отправить» уходил человеку без вопроса владельцу.
 * Нестрого: вся строка, каждое слово, русские имена. Ложное срабатывание стоит одного лишнего вопроса.
 */
export function riskyAppCategory(app: string): { category: RiskCategory; human: string } | null {
  const s = app.trim().toLowerCase().replace(/\.exe$/u, "");
  if (!s) return null;
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // «max»/«zoom» — и мессенджеры, и слова в чужих названиях («3ds Max», «Zoom Player»): их — только целым именем.
  const AMBIGUOUS = new Set(["max", "zoom"]);
  for (const cand of [s, s.replace(/[^\p{L}\p{N}]+/gu, ""), ...words.filter((w) => !AMBIGUOUS.has(w))]) {
    const hit = riskyProcessCategory(APP_NAME_ALIASES[cand] ?? cand);
    if (hit) return hit;
  }
  return null;
}

/**
 * Клавиша-коммит: Enter и его сочетания (Ctrl+Enter — «отправить» в Telegram/Discord/почте,
 * Shift+Enter в некоторых клиентах — перенос строки, но в других — отправка; считаем коммитом
 * консервативно). «Return» — синоним Enter у части клавиатурных API.
 */
export function isCommitKeyCombo(combo: string): boolean {
  const c = combo.trim().toLowerCase().replace(/\s+/g, "");
  if (!c) return false;
  const parts = c.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (key !== "enter" && key !== "return") return false;
  const mods = parts.slice(0, -1);
  return mods.every((m) => m === "ctrl" || m === "control" || m === "shift" || m === "");
}

/**
 * Глаголы коммита — «опубликовать/отправить/оплатить/подтвердить/провести/подписать/купить/оформить/перевести»
 * и их английские пары. Ловит и «подписаться» (лишний вопрос на YouTube — безопасная сторона).
 * W4: переехал сюда из серверного commit-gate — клиентский рубеж (act по тексту кнопки с SDK-моста) читает тот же список.
 * W1 (B-5): УДАЛЕНИЕ — тоже необратимое («Удалить навсегда» в почте/облаке уходило без вопроса): «удал…», «стереть»,
 * delete/erase. Не удаление: «удалённый/удаленный (рабочий стол, доступ)», «удалёнка», «удалось» — эти основы исключены;
 * «Deleted» (папка «Удалённые») — тоже. Ложный вопрос дешевле необратимого удаления, но mstsc спрашивать не должен.
 * ⚠️ Литерал — ОДНОЙ строкой `/…/iu;`: его исходник читает стенд расширения (apps/extension/test/cdp-harness.mjs).
 */
export const COMMIT_WORDS_RE =
  /(?<![\p{L}])(?:опубликов|разместит|размести|отправ|оплат|заплат|подтвер|провест|провед|подпис|купит|оформ|заказат|перевес|перевод|разослат|удал(?![её]нн|[её]нк|ось)|стерет|publish|post\b|send\b|pay\b|confirm|submit|buy\b|checkout|place order|transfer|sign\b|approve|delete(?!d)|erase\b)/iu;

/**
 * Единое «включено» для флагов коммита (`enter`/`submit`) от LLM: true, 1, "true"/"1"/"yes"/"да". Сервер нормализует
 * по нему до отправки в расширение, гейт §14 и петля судят по нему же — три потребителя, одна правда (W1-ревью LOOP-3).
 */
export function isOnFlag(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === "string" && /^(true|1|yes|да)$/iu.test(v.trim());
}
