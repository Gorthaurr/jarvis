/**
 * W2 П2 (§0): ЧИСТЫЕ ПРИЗНАКИ рубежа секретов — без сайдкара и без состояния.
 *
 *  - `isSecretElement` — поле пароля/кода по элементу UIA: маркер сайдкара `•••` (C# ставит его ВМЕСТО значения поля
 *    с IsPassword, UiaGrounder.cs) или подсказка в имени/automationId ПОЛЯ ВВОДА. Подсказку у кнопок и ссылок не
 *    берём: «Показать пароль»/«Забыли пароль?» — не поле, печать туда не уходит.
 *  - `keyEffect` — что нажатие делает с набранным в поле (буфер Луны): символ, забой, правка на месте, вставка,
 *    автоввод менеджера паролей или «новая эпоха фокуса».
 */
import { keyClass, looksLikeSecretField, normalizeCombo, parseKeyCombo } from "@jarvis/shared";

/** Маркер значения поля-пароля в снапшоте сайдкара (и то же у других провайдеров UIA — только точки/звёзды). */
const MASK_VALUE_RE = /^[•●*]{3,}$/u;
/** Роли, у которых имя — подпись ПОЛЯ ВВОДА (снапшот: «edit»; ground/read.screen: «ControlType.Edit»/«Edit»). */
const EDIT_ROLE_RE = /^(?:controltype\.)?(?:edit|combobox)$/iu;
/** Метка команды «Вставить» (меню, кнопка панели) — вставка из буфера обмена. */
export const PASTE_LABEL_RE = /встав|paste/iu;

/** Роль неизвестна (старый сайдкар, ground без роли) — судим как поле ввода: ложный отказ дешевле пропуска. */
export function isEditLike(role: string | undefined | null): boolean {
  const r = String(role ?? "").trim();
  return r === "" || EDIT_ROLE_RE.test(r);
}

export interface ElementSigns {
  role?: string | null;
  name?: string | null;
  automationId?: string | null;
  value?: string | null;
}

/** Элемент — поле пароля/одноразового кода. */
export function isSecretElement(e: ElementSigns): boolean {
  if (typeof e.value === "string" && MASK_VALUE_RE.test(e.value)) return true;
  if (!isEditLike(e.role)) return false;
  return looksLikeSecretField([e.name ?? "", e.automationId ?? ""]);
}

/** Подпись элемента для метки команды («Вставить») — имя и automationId. */
export function elementLabel(e: ElementSigns): string {
  return [e.name ?? "", e.automationId ?? ""].filter(Boolean).join(" ");
}

export type KeyEffect =
  | { kind: "char"; ch: string } // печатный символ (в т.ч. пробел) дописывается в поле
  | { kind: "backspace" }
  | { kind: "keep" } // правка/навигация ВНУТРИ поля, одиночные Shift/Ctrl — поле то же
  | { kind: "paste" }
  | { kind: "autotype" }
  | { kind: "reset" }; // Enter, Tab, Esc, Alt/Win, F-клавиши… — фокус/поле могли смениться

/** Правка и навигация внутри поля: набранное остаётся в поле — буфер не сбрасываем (иначе «End» рвал бы Луну). */
const IN_FIELD_KEYS: ReadonlySet<string> = new Set(["delete", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end"]);
/** Ctrl+буква, которые не уводят фокус: выделить всё, копировать, вырезать, отменить. */
const CTRL_IN_FIELD: ReadonlySet<string> = new Set(["a", "c", "x", "z"]);

const KEEP: KeyEffect = { kind: "keep" };
const RESET: KeyEffect = { kind: "reset" };

/**
 * Эффект ИТОГОВОГО комбо (удерживаемые клавиши ∪ новое нажатие — автоввод собирается и удержанием Ctrl, Alt + A).
 * Классы вставки/автоввода — данные `@jarvis/shared` (PASTE_COMBOS/AUTOTYPE_COMBOS).
 */
export function keyEffect(effectiveCombo: string): KeyEffect {
  const cls = keyClass(effectiveCombo);
  if (cls === "autotype") return { kind: "autotype" };
  if (cls === "paste") return { kind: "paste" };
  const k = parseKeyCombo(effectiveCombo);
  if (!k) {
    // Одни модификаторы: Shift/Ctrl сами по себе ничего не вводят; Alt/Win уводят фокус (меню окна, «Пуск»).
    const parts = normalizeCombo(effectiveCombo).split("+").filter(Boolean);
    return parts.length > 0 && parts.every((p) => p === "shift" || p === "ctrl") ? KEEP : RESET;
  }
  if (k.alt || k.meta) return RESET;
  if (k.ctrl) return (!k.shift && CTRL_IN_FIELD.has(k.key)) || IN_FIELD_KEYS.has(k.key) ? KEEP : RESET;
  if (k.key === "space") return { kind: "char", ch: " " };
  if (k.key === "backspace") return { kind: "backspace" };
  if (IN_FIELD_KEYS.has(k.key)) return KEEP;
  if (k.key.length === 1) {
    // Shift+цифра — символ раскладки («$», «;»), не цифра: для Луны он рвёт хвост цифр.
    if (k.shift) return { kind: "char", ch: /\d/u.test(k.key) ? "#" : k.key.toUpperCase() };
    return { kind: "char", ch: k.key };
  }
  return RESET;
}
