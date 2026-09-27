/**
 * W2 П2: судья «secret» (§0) рубежа инжекции. НЕОДОБРЯЕМ: грант §14 в области команды его не снимает — пароли,
 * коды и карты владелец вводит сам (отказ без needsApproval: вопроса не будет).
 *
 *  - type (и предпроверка всего текста): Луна по набранному в поле + новый текст — ВСЕГДА, в любой программе;
 *    поле-секрет (память клика, элемент в фокусе) → отказ.
 *  - key: автоввод менеджера паролей (Ctrl+Alt+A, Ctrl+Shift+L, Ctrl+\) — отказ всегда, в т.ч. собранный удержанием;
 *    вставка (Ctrl+V, Shift+Insert, Ctrl+Shift+V) — буфер обмена и поле; печатный символ — Луна по склейке и память
 *    клика (без read.screen: цена UIA на каждую клавишу — игры жмут клавиши сериями); забой, оставляющий в поле карту.
 *  - invoke setValue: Луна по значению, поле по зеркалу handle (`•••`, подсказки).
 *  - click / invoke / mouse down: команда «Вставить» (paste-guard).
 * Состояние между инжекциями — secret-memory.ts (наполняет inject.ts после суда всех судей).
 */
import { carriesCardNumber, createLogger } from "@jarvis/shared";
import { fieldVerdict } from "./focused-field.js";
import type { InjectionCase, Judge, JudgeDenial } from "./injection-guard.js";
import { inputBuffer } from "./input-buffer.js";
import { cardInTyped, judgeClickPaste, judgePaste, secretDenial } from "./paste-guard.js";
import { effectiveCombo, mirrorEntry, syncSecretState } from "./secret-memory.js";
import { elementLabel, isSecretElement, keyEffect } from "./secret-signs.js";

const log = createLogger("actuator:secret");

const CARD = "§0: номер банковской карты не ввожу (набранное в поле вместе с новым текстом проходит проверку Луна) — карту вводит владелец сам.";
const fieldRefusal = (why: string): string => `§0: поле пароля/кода (${why}) — пароли и коды подтверждения не ввожу, введите сами.`;

async function judgeText(c: InjectionCase, text: string): Promise<JudgeDenial | null> {
  if (!text) return null;
  if (cardInTyped(text)) return secretDenial("card", CARD);
  const f = await fieldVerdict(c.facts, { focused: true, text, preflight: c.preflight === true });
  return f.secret ? secretDenial("field", fieldRefusal(f.why ?? "поле-секрет")) : null;
}

async function judgeKey(c: InjectionCase): Promise<JudgeDenial | null> {
  if (c.params.mode === "up") return null; // отпускание ничего не вводит
  const combo = String(c.params.combo ?? "");
  const effect = keyEffect(effectiveCombo(combo));
  if (effect.kind === "autotype") {
    return secretDenial("autotype", `§0: «${combo}» — автоввод менеджера паролей, не нажимаю: пароли вводит владелец сам.`);
  }
  if (effect.kind === "paste") return judgePaste(c.facts, `вставку «${combo}»`);
  // Забой, после которого в поле остаётся карта («…5675» + лишняя «9», затем Backspace), — та же печать карты.
  if (effect.kind === "backspace") return carriesCardNumber(inputBuffer.digits(41).slice(0, -1)) ? secretDenial("card", CARD) : null;
  if (effect.kind !== "char") return null;
  if (cardInTyped(effect.ch)) return secretDenial("card", CARD);
  const f = await fieldVerdict(c.facts, { focused: false });
  return f.secret ? secretDenial("field", fieldRefusal(f.why ?? "поле-секрет")) : null;
}

async function judgeInvoke(c: InjectionCase): Promise<JudgeDenial | null> {
  const e = mirrorEntry(c.params.handle);
  if (c.params.pattern !== "setValue") return judgeClickPaste(c.facts, e ? elementLabel(e) : null);
  // SetValue ЗАМЕНЯЕТ содержимое поля — склейки с набранным нет: Луна по самому значению.
  if (carriesCardNumber(String(c.params.value ?? ""))) return secretDenial("card", CARD);
  if (e && isSecretElement(e)) return secretDenial("field", fieldRefusal(`«${e.name || e.role}»`));
  if (!e) log.warn("§0: setValue по handle без записи в зеркале — поле не проверено, Луна проверена");
  return null;
}

function pointOf(p: Record<string, unknown>): { x: number; y: number } | undefined {
  const x = p.x;
  const y = p.y;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

async function judgePointer(c: InjectionCase): Promise<JudgeDenial | null> {
  if (c.op === "mouse" && c.params.op !== "down") return null; // move/up/wheel/drag — не нажатие по цели
  if (c.params.handle !== undefined) {
    const e = mirrorEntry(c.params.handle);
    return judgeClickPaste(c.facts, e ? elementLabel(e) : null);
  }
  return judgeClickPaste(c.facts, null, pointOf(c.params));
}

export const secretJudge: Judge = async (c) => {
  syncSecretState();
  switch (c.op) {
    case "type":
      return judgeText(c, String(c.params.text ?? ""));
    case "key":
      return judgeKey(c);
    case "invoke":
      return judgeInvoke(c);
    case "click":
    case "mouse":
      return judgePointer(c);
    default:
      return null;
  }
};
