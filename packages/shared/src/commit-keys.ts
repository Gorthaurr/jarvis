/**
 * W2 (пакет 0, решение №2): КЛАСС КЛАВИШИ для рубежа инжекции — allowlist, а не денилист.
 *
 * Прежний гейт узнавал коммит по денилисту («в combo есть Enter»): Space на кнопке «Отправить», Alt+S в Outlook,
 * Ctrl+Shift+Enter и любая незнакомая программе клавиша уходили без вопроса (закон CLAUDE.md «денилисты неполны»).
 * Теперь безопасны только клавиши из SAFE-набора (печать, правка, навигация); Space/Enter судятся по элементу
 * в фокусе (focusPress); прочее — коммит. Опасные/автоввод/вставка — отдельные классы: их судят другие рубежи
 * (блок-лист §6 «не навреди», §0 секреты).
 *
 * Списки — ДАННЫЕ: правятся строкой после живого смоука.
 */
import { parseKeyCombo } from "./key-combo.js";

/** Нормализовать комбо: нижний регистр, без пробелов, алиасы (meta/super/lwin→win, del→delete), дедуп, сорт. */
export function normalizeCombo(combo: string): string {
  return String(combo ?? "")
    .toLowerCase()
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) =>
      k === "meta" || k === "super" || k === "lwin" || k === "rwin" || k === "windows" || k === "cmd"
        ? "win"
        : k === "del"
          ? "delete"
          : k === "control"
            ? "ctrl"
            : k,
    )
    // Дедуп ПЕРЕД сортировкой: «Alt+Alt+F4» → «alt+f4» (ОС трактует дубль модификатора так же) — иначе обход блок-листа.
    .reduce<string[]>((acc, k) => (acc.includes(k) ? acc : [...acc, k]), [])
    .sort()
    .join("+");
}

const normSet = (list: readonly string[]): ReadonlySet<string> => new Set(list.map(normalizeCombo));

/**
 * §6 «не навреди»: закрывают/блокируют окно или систему (инцидент «закрой Доту» → Alt+F4 закрыл САМ Джарвис).
 * W2: + Win+V — история буфера обмена вставляет прошлые копии (пароль, карта) мимо §0.
 */
export const BLOCKED_COMBOS = normSet(["Alt+F4", "Win+L", "Win+R", "Win+D", "Win+M", "Win+Tab", "Ctrl+Alt+Delete", "Ctrl+Alt+Del", "Alt+Space", "Win+V"]);

/** Автоввод менеджеров паролей (KeePass, Bitwarden, 1Password): печатают секрет в поле с фокусом — §0, неодобряемо. */
export const AUTOTYPE_COMBOS = normSet(["Ctrl+Alt+A", "Ctrl+Shift+L", "Ctrl+\\"]);

/** Вставка из буфера обмена: судится по содержимому буфера и полю в фокусе (§0, П2). */
export const PASTE_COMBOS = normSet(["Ctrl+V", "Shift+Insert", "Ctrl+Shift+V"]);

/** Запрещённое ли комбо (закрывает/блокирует окно/систему, в т.ч. может закрыть Джарвис). */
export function isBlockedCombo(combo: string): boolean {
  return BLOCKED_COMBOS.has(normalizeCombo(combo));
}

export type KeyClass = "safe" | "paste" | "focusPress" | "commit" | "blocked" | "autotype";

/** Правка и навигация: безопасны без модификаторов и с Shift/Ctrl (выделение, прыжок по словам, вкладки). */
const EDIT_NAV_KEYS: ReadonlySet<string> = new Set([
  "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown", "tab", "escape",
]);
/** Ctrl+буква, которые ничего не отправляют: выделить всё, копировать, вырезать, отменить. */
const CTRL_SAFE_LETTERS: ReadonlySet<string> = new Set(["a", "c", "x", "z"]);

/**
 * Класс клавиши. Разбор — `parseKeyCombo` (общий с расширением); незнакомое/недействительное комбо — commit
 * (не знаем, что нажмётся). Alt/Win с чем угодно — commit (Alt+S «отправить» в Outlook).
 */
export function keyClass(combo: string): KeyClass {
  const n = normalizeCombo(combo);
  if (BLOCKED_COMBOS.has(n)) return "blocked";
  if (AUTOTYPE_COMBOS.has(n)) return "autotype";
  if (PASTE_COMBOS.has(n)) return "paste";
  const k = parseKeyCombo(combo);
  if (!k || k.alt || k.meta) return "commit";
  if (k.key === "enter" || k.key === "space") return k.ctrl || k.shift ? "commit" : "focusPress";
  if (EDIT_NAV_KEYS.has(k.key)) return "safe";
  if (k.key.length === 1) {
    if (!k.ctrl) return "safe"; // печатный символ (Shift — регистр)
    return !k.shift && CTRL_SAFE_LETTERS.has(k.key) ? "safe" : "commit";
  }
  return "commit"; // F1–F12
}

/** Каноническая запись комбо для подписи: модификаторы в порядке ctrl+alt+shift+meta, затем клавиша. */
export function canonicalCombo(combo: string): string {
  const k = parseKeyCombo(combo);
  if (!k) return normalizeCombo(combo);
  return [k.ctrl && "ctrl", k.alt && "alt", k.shift && "shift", k.meta && "meta", k.key].filter(Boolean).join("+");
}
