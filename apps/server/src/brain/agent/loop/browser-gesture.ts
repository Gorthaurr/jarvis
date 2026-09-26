// W1 «браузерные руки»: жест ОТПРАВКИ у browser_act/browser_batch — зеркало actGesture/inspectBatchSteps (util.ts) для
// рук во вкладке. Без него набор в поле и следующий Enter/клик «Отправить» проходили как обычные клики: readback поля
// (observed) снимал долг, и «Отправлено» звучало без взгляда на исход — ровно класс «ушло в Клод» (форензика 07-14).
import { isPasteCombo, isSendKey } from "./util.js";

export interface WebGesture {
  /** Жест, который после набора текста КОММИТИТ его (Enter/клик/submit). */
  commit: boolean;
  /** Набор текста/значения в поле — следующий коммит станет отправкой. */
  composes: boolean;
}

const NONE: WebGesture = { commit: false, composes: false };

/**
 * Поля шага: новая схема кладёт их на верхний уровень (`browser_act{intent, ref, value}`), прежняя и шаги берста — в
 * `params`. Читаем оба места (верхний уровень главнее) — фикстура обязана совпадать с тем, что реально шлёт модель.
 */
export function webStepFields(input: unknown): Record<string, unknown> {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const p = i.params && typeof i.params === "object" ? (i.params as Record<string, unknown>) : {};
  return { ...p, ...i };
}

/** LLM шлёт `enter:"true"` строкой, а расширение отправляет по truthy — коммитом считаем так же, как оно. */
function truthy(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === "string" && /^(true|1|yes|да)$/iu.test(v.trim());
}

/** Что за жест у одного browser_act (или шага берста) — по интенту и полям. */
export function webActGesture(input: unknown): WebGesture {
  const f = webStepFields(input);
  const intent = String(f.intent ?? f.action ?? "");
  switch (intent) {
    case "type":
    case "set":
    case "select": {
      // set с `checked` — переключатель (галочка/радио), это не набор; set/select со значением — ввод в поле/выбор.
      const composes = intent === "type" || (f.checked === undefined && (f.value !== undefined || f.option !== undefined));
      return { composes, commit: composes && (truthy(f.enter) || truthy(f.submit)) };
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
    const g = webActGesture(step);
    if (g.commit) {
      hasSend = true;
      if (composed || g.composes) committed = true;
    }
    if (g.composes) composed = true;
    if (g.commit || g.composes) last = g;
  }
  return { committed, hasSend, endsComposed: last.composes && !last.commit };
}
