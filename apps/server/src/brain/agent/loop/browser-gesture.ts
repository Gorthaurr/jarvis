// W1 «браузерные руки»: жест ОТПРАВКИ у browser_act/browser_batch — зеркало actGesture/inspectBatchSteps (util.ts) для
// рук во вкладке. Без него набор в поле и следующий Enter/клик «Отправить» проходили как обычные клики: readback поля
// (observed) снимал долг, и «Отправлено» звучало без взгляда на исход — ровно класс «ушло в Клод» (форензика 07-14).
// W1-ревью (LOOP-7/W1-8/T5, LOOP-3): поля и «включено» — ТЕ ЖЕ, что у хендлера, §14-гейта и расширения: форма —
// browser-params.ts (при конфликте верха и params побеждает params), флаг enter/submit — isOnFlag из @jarvis/shared.
// Своя копия читала верх главнее: {type, enter:false, params:{enter:true}} расширение отправляло, а петля видела набор.
import { isOnFlag } from "@jarvis/shared";
import { browserActParams, browserStepFields } from "../../tools/browser-params.js";
import { isPasteCombo, isSendKey } from "./util.js";

export interface WebGesture {
  /** Жест, который после набора текста КОММИТИТ его (Enter/клик/submit). */
  commit: boolean;
  /** Набор текста/значения в поле — следующий коммит станет отправкой. */
  composes: boolean;
}

const NONE: WebGesture = { commit: false, composes: false };

/** Жест по интенту и полям (поля уже в форме исполнителя — browser-params.ts). */
function gestureOf(intent: string, f: Record<string, unknown>): WebGesture {
  switch (intent) {
    case "type":
    case "set":
    case "select": {
      // set с `checked` — переключатель (галочка/радио), это не набор; set/select со значением — ввод в поле/выбор.
      const composes = intent === "type" || (f.checked === undefined && (f.value !== undefined || f.option !== undefined));
      return { composes, commit: composes && (isOnFlag(f.enter) || isOnFlag(f.submit)) };
    }
    case "key": {
      const combo = f.combo ?? f.key;
      return { commit: isSendKey(combo), composes: isPasteCombo(combo) };
    }
    case "click":
    case "enter":
    case "submit":
      return { commit: true, composes: false };
    default:
      return NONE; // hover/scroll_to/scroll/play/pause/seek/back/forward — не набор и не коммит
  }
}

/** Жест одного browser_act: intent — с верха (как у хендлера), поля — browserActParams (плоские + params поверх). */
export function webActGesture(input: unknown): WebGesture {
  const i = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return gestureOf(String(i.intent ?? "").trim(), browserActParams(i));
}

/** Жест шага берста — поля так, как их читает расширение (browserStepFields: верх шага + params поверх). */
function webStepGesture(step: unknown): WebGesture {
  const { intent, fields } = browserStepFields(step);
  return gestureOf(intent, fields);
}

/**
 * Берст шагов `{ref, intent, params}` (форма ≠ input_batch с `{action, params}`): есть ли пара «набор → коммит» (или
 * шаг type/set с enter:true), есть ли коммит-шаг вообще, и оканчивается ли берст набором (следующий Enter — отправка).
 */
export function inspectWebBatch(input: unknown): { committed: boolean; endsComposed: boolean; hasSend: boolean } {
  const steps = (input as { steps?: unknown } | undefined)?.steps;
  if (!Array.isArray(steps)) return { committed: false, endsComposed: false, hasSend: false };
  let composed = false;
  let committed = false;
  let hasSend = false;
  let last: WebGesture = NONE;
  for (const step of steps) {
    const g = webStepGesture(step);
    if (g.commit) {
      hasSend = true;
      if (composed || g.composes) committed = true;
    }
    if (g.composes) composed = true;
    if (g.commit || g.composes) last = g;
  }
  return { committed, hasSend, endsComposed: last.composes && !last.commit };
}
