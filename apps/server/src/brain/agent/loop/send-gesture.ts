// W1-ревью (LOOP-2, LOOP-8): жест ОТПРАВКИ одного вызова и долг его сверки — одно место для исхода «успех»
// (tool-classify applySuccessEffects) и «исход неизвестен» (unknownOutcome: isError + uncertain). Разойдись они,
// таймаут расширения после клика «Оформить» оставлял ход без долга сверки: «Заказ оформлен» уходило без взгляда.
import { isSendKey, isPasteCombo, inspectBatchSteps } from "./util.js";
import { actCallGesture, inspectActSeries, isActSeries } from "./act-gesture.js";
import { inspectWebBatch, webActGesture } from "./browser-gesture.js";
import type { LoopState } from "./state.js";
import type { ToolResult } from "../../tools/dispatch.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { isBlindMutate } from "../error-voice.js";

type ToolUse = LlmResponse["toolUses"][number];

export interface SendGesture {
  /** КОММИТ отправки: жест-коммит после набора (composedPending), берст «набор → коммит», набор+коммит одним вызовом. */
  sendCommit: boolean;
  /** Вызов оставляет набранный текст в поле — следующий коммит станет отправкой. */
  composes: boolean;
}

const NO_BATCH = { committed: false, endsComposed: false, hasSend: false };
const NO_GESTURE = { commit: false, composes: false };

/**
 * §P1-отправка (форензика «Отправлено — ушло в Клод», а сообщение осталось в поле): КОММИТ = send-key / клик / кнопка
 * после набора, берст compose→send (input_batch; W1 — browser_batch `{ref,intent,params}`), act/browser_act с набором и
 * коммитом одним вызовом (type{enter:true}). Ложный позитив (клик мимо кнопки) стоит одной лишней сверки.
 */
export function sendGestureOf(tu: ToolUse, composedPending: boolean): SendGesture {
  const combo = (tu.input as { combo?: unknown }).combo;
  // W2 (П4): серия act{steps} — как берст; одиночный act с enter:true/triple — act-gesture.ts.
  const batch = tu.name === "input_batch" ? inspectBatchSteps(tu.input) : tu.name === "browser_batch" ? inspectWebBatch(tu.input) : isActSeries(tu.name, tu.input) ? inspectActSeries(tu.input) : NO_BATCH;
  const actG = tu.name === "act" ? actCallGesture(tu.input) : tu.name === "browser_act" ? webActGesture(tu.input) : NO_GESTURE;
  const commitGesture =
    (tu.name === "input_key" && isSendKey(combo)) || tu.name === "input_click" || tu.name === "input_mouse" || tu.name === "ui_invoke" || actG.commit;
  const sendCommit = ((commitGesture || batch.hasSend) && composedPending) || batch.committed || (actG.commit && actG.composes);
  const composes =
    tu.name === "input_type" ||
    (tu.name === "ui_invoke" && (tu.input as { pattern?: unknown }).pattern === "setValue") ||
    (tu.name === "input_key" && isPasteCombo(combo)) ||
    (actG.composes && !actG.commit) ||
    batch.endsComposed;
  return { sendCommit, composes };
}

/** Взвести долг сверки после ИСПОЛНЕННОЙ (или, возможно, исполненной) руки: коммит → долг ИСХОДА отправки. */
export function armSendDebt(st: LoopState, g: SendGesture, blindUnobserved: boolean): void {
  if (g.sendCommit) {
    st.honesty.blindMutatePending = true;
    st.honesty.sendCommitDebt = true; // исход отправки сверяется ТОЛЬКО реальным взглядом
    st.honesty.composedPending = false;
  } else if (blindUnobserved) {
    st.honesty.blindMutatePending = true;
  }
  if (g.composes) st.honesty.composedPending = true; // взвод «набрал текст» — любым путём
}

/** Исполненный префикс берста (k шагов до остановки) — вход только ради ЖЕСТА: новый объект, вызов модели не трогаем. */
function executedPrefix(tu: ToolUse, k: number): ToolUse {
  const input = tu.input as { steps?: unknown };
  return Array.isArray(input.steps) ? { ...tu, input: { ...input, steps: input.steps.slice(0, k) } } : tu;
}

/**
 * Ошибка слепой руки, которая МОГЛА что-то сделать. LOOP-2: «исход неизвестен» (таймаут/разрыв ПОСЛЕ отправки клика/
 * берста) — дело могло уйти: тот же долг сверки, что у успеха без наблюдения (и долг исхода отправки, если жест —
 * коммит). р2 loop-regress-3: берст остановлен после k ИСПОЛНЕННЫХ шагов (partialSteps) — долг по исполненному
 * префиксу (набор → composedPending, набор+коммит → долг отправки): сервер сам велит «доделай шаг отдельным
 * browser_act», и следующий клик — коммит набранного. Вуальный отказ сюда не идёт: у него свой учёт
 * (overlayActionInjected → терминал «исход не подтверждён»).
 */
export function armUncertainDebt(st: LoopState, tu: ToolUse, r: ToolResult, eff: "verify" | "mutate" | "neutral"): void {
  if (!r.isError || r.overlayDenied === true || eff !== "mutate" || !isBlindMutate(tu.name)) return;
  const k = r.partialSteps;
  if (r.uncertain === true) armSendDebt(st, sendGestureOf(tu, st.honesty.composedPending), true);
  else if (typeof k === "number" && k > 0) armSendDebt(st, sendGestureOf(executedPrefix(tu, k), st.honesty.composedPending), true);
}
