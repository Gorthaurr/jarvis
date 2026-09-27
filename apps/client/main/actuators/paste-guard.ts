/**
 * W2 П2 (§0): ВСТАВКА ИЗ БУФЕРА ОБМЕНА — печать мимо type. Судится по содержимому буфера обмена (Луна вместе с уже
 * набранным в поле) и по полю в фокусе (вставка ЧЕГО УГОДНО в поле пароля/кода — ввод секрета).
 * Пути вставки: клавиши (PASTE_COMBOS: Ctrl+V, Shift+Insert, Ctrl+Shift+V — в т.ч. собранные удержанием) и команда
 * «Вставить» (клик/invoke по элементу с такой меткой: контекстное меню, кнопка панели).
 * Метка клика неизвестна (физический клик по точке без UIA-элемента), а в буфере обмена карта → отказ: это могла
 * быть вставка, и отличить её нечем. Буфер без карты — клик не судим (ни одного лишнего ground.at).
 */
import { carriesCardNumber } from "@jarvis/shared";
import type { Point } from "./coords.js";
import { fieldVerdict } from "./focused-field.js";
import type { InjectionFacts } from "./injection-facts.js";
import type { JudgeDenial } from "./injection-guard.js";
import { inputBuffer } from "./input-buffer.js";
import { PASTE_LABEL_RE } from "./secret-signs.js";

/** Отказ §0: неодобряем (нет needsApproval) — сервер не задаёт вопроса, модель говорит владельцу правду. */
export function secretDenial(reason: "card" | "field" | "paste" | "autotype", message: string): JudgeDenial {
  return { message, data: { secretGuard: reason } };
}

/** Луна по склейке: хвост набранного в поле + новый текст (карта по кускам, поцифровые клавиши, шаги батча). */
export function cardInTyped(text: string): boolean {
  return carriesCardNumber(inputBuffer.digits(40) + text);
}

/** Вставка (клавишей или командой «Вставить»): буфер обмена с картой или поле-секрет → отказ. */
export async function judgePaste(facts: InjectionFacts, how: string): Promise<JudgeDenial | null> {
  const clip = facts.clipboardText();
  if (!clip) return null;
  if (cardInTyped(clip)) {
    return secretDenial("paste", `§0: в буфере обмена номер банковской карты — ${how} не делаю: карту вводит владелец сам.`);
  }
  const f = await fieldVerdict(facts, { focused: true, text: clip });
  if (f.secret) {
    return secretDenial("paste", `§0: ${how} в поле пароля/кода (${f.why ?? "поле-секрет"}) — пароли и коды подтверждения не ввожу, введите сами.`);
  }
  return null;
}

/**
 * Клик/invoke: не команда ли это «Вставить». `label` — подпись цели (зеркало handle), null — неизвестна; `point` —
 * точка физического клика (тогда подпись добирается `ground.at`, но только если в буфере обмена карта).
 */
export async function judgeClickPaste(facts: InjectionFacts, label: string | null, point?: Point): Promise<JudgeDenial | null> {
  const clip = facts.clipboardText();
  if (!clip) return null;
  const card = cardInTyped(clip);
  let name = label;
  if (name === null && card && point) name = (await facts.elementAt(point))?.name ?? null;
  if (name !== null && PASTE_LABEL_RE.test(name)) return judgePaste(facts, `клик «${name.slice(0, 40)}»`);
  if (name === null && card) {
    return secretDenial("paste", "§0: в буфере обмена номер банковской карты, а что под этим кликом — не определить (нет UIA-элемента): это могла быть вставка — не жму.");
  }
  return null;
}
