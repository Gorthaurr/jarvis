// W3 «Петля»: одна итерация петли: гарды → тир → thinking → модель → текст ИЛИ инструменты → пост-раунд.
import { applyIterationGuards } from "./guards.js";
import { adjustTierBeforeCall } from "./tiering.js";
import { prepareCall } from "./thinking.js";
import { callModel, accountRound, noteStub } from "./model-call.js";
import { handleTextTurn } from "./text-turn.js";
import { runToolRound } from "./tool-round.js";
import { finishRound } from "./post-round.js";
import { takeRoundSnapshot, startRoundTiming } from "./round-snapshot.js";
import type { LoopCtx } from "./context.js";

export async function runStep(ctx: LoopCtx, step: number): Promise<"break" | "next"> {
  const { st, task } = ctx;
  st.progress.loopIters += 1; // #3: считаем КАЖДУЮ итерацию (вкл. continue) — для честного capExhausted
  // Отмена ≤1 шага (§20): cancel-флаг проверяется ПЕРЕД каждым шагом (и РАНЬШЕ queueTimedOut:
  // «отмени» во время очереди — тихий cancelled-терминал, а не вторая фраза про таймаут очереди).
  if (task.cancel.cancelled) {
    st.exit.cancelled = true;
    return "break";
  }
  const snap = takeRoundSnapshot(st);
  if ((await applyIterationGuards(ctx)) === "break") return "break";
  const timing = startRoundTiming(st);
  adjustTierBeforeCall(ctx);
  const prep = prepareCall(ctx, step);
  const { resp, llmCallStartedMs } = await callModel(ctx, step, prep);
  accountRound(ctx, step, resp, llmCallStartedMs);
  if (noteStub(ctx, resp) === "break") return "break";
  if (resp.toolUses.length === 0) return handleTextTurn(ctx, step, resp, snap) === "break" ? "break" : "next";
  const round = await runToolRound(ctx, resp);
  const after = await finishRound(ctx, resp, round, timing);
  return after === "break" ? "break" : "next";
}
