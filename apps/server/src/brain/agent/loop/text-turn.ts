// W3 «Петля»: текстовый ход модели: докрутка, нудж-политика, финал.
import type { LoopCtx } from "./context.js";
import type { RoundSnapshot } from "./round-snapshot.js";
import { continueAfterMaxTokens, antiCapitulation, verifyNudge, goalCheck, emptyFinalNudge } from "./nudge-policy.js";
import type { LlmResponse } from "../../../integrations/llm.js";

export function handleTextTurn(ctx: LoopCtx, step: number, resp: LlmResponse, snap: RoundSnapshot): "break" | "continue" {
  const { st } = ctx;
  st.progress.finalText += resp.text;
  // Ревью волны Б 3-й проход (#5): запоминаем ПОСЛЕДНИЙ реальный ответ модели. Нуджи (goal-check/
  // verify/empty) ниже обнуляют finalText, чтобы заставить переспросить, — но при исчерпании капа
  // (особенно Б6-кап 3) переспросить негде, и capExhausted соврал бы «не успел», хотя ответ БЫЛ.
  if (resp.text.trim()) st.progress.lastAnswer = resp.text.trim();
  if (continueAfterMaxTokens(ctx, step, resp)) return "continue";
  if (antiCapitulation(ctx, resp, snap)) return "continue";
  if (verifyNudge(ctx, resp)) return "continue";
  if (goalCheck(ctx, resp, snap)) return "continue";
  if (emptyFinalNudge(ctx, resp)) return "continue";
  if (!st.progress.finalText) st.progress.finalText = "Готово.";
  return "break";
}
