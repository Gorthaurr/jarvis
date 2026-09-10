/**
 * W0 (2026-09-09): ОБЩИЕ ДАННЫЕ §14-гейта необратимых коммитов — один список для сервера
 * (`brain/tools/commit-gate.ts`) и клиента (`actuators/commit-guard.ts`).
 *
 * Зачем на клиенте: серверный гейт стоит только в `dispatchTool`, а SDK-мост (`act-bridge`) и реплей
 * навыка (`skill-runner/client-actuator`) зовут клиентские актуаторы НАПРЯМУЮ — prompt-injected
 * python-скрипт (`jarvis.key("enter")` при Telegram на переднем плане) или отравленный шаг навыка
 * коммитили отправку без единого вопроса владельцу. Списки — данные; расширять строкой.
 */

export type RiskCategory = "bank" | "payment" | "edo" | "gov" | "market" | "social" | "messenger";

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
 */
export const COMMIT_WORDS_RE =
  /(?<![\p{L}])(?:опубликов|разместит|размести|отправ|оплат|заплат|подтвер|провест|провед|подпис|купит|оформ|заказат|перевес|перевод|разослат|publish|post\b|send\b|pay\b|confirm|submit|buy\b|checkout|place order|transfer|sign\b|approve)/iu;
