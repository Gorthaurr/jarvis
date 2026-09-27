// W3 (V-4 = B-F7): пофразный стрим ответа модели в голос — шаг 0 и ФИНАЛ разговорного хода после инструментов.
// До W3 стримился только шаг 0: «какая погода?» → web_search → ответ молчал до конца генерации и звучал целиком
// из терминала. Теперь финал разговорного хода звучит по мере генерации — но только там, где терминал не заменит
// его другой фразой (нудж сверки, приписка о занятом вводе/вуали): иначе прозвучали бы ДВА ответа.
import { emitSentence } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { LoopState } from "./state.js";
import type { LlmRequest, LlmResponse } from "../../../integrations/llm.js";
import type { ReplySink } from "../types.js";
import { SentenceChunker } from "../../nlu/sentences.js";
import { looksLikeGiveUp } from "../error-voice.js";

/**
 * Можно ли голосить ответ шага > 0 по мере генерации. Только ход БЕЗ единого дела: после мутации финал судят
 * verify-нудж, goal-check и терминал провала (приписка «ввод был занят», «вуаль», masked-failure) — стримленный
 * финал они уже не отзовут. Висящий долг сверки/отправки или отказ ввода — тем более.
 */
export function finalStreamSafe(st: LoopState): boolean {
  const h = st.honesty;
  return !h.anyMutateAttempted && !h.blindMutatePending && !h.sendCommitDebt && !h.inputDenied && !h.overlayDeniedAny;
}

/** Стримить ли этот вызов модели: шаг 0 — как раньше (кроме sync-first); шаг > 0 — разговорный ход без дел. */
export function shouldStreamStep(ctx: LoopCtx, step: number): boolean {
  const { sink, opts, st } = ctx;
  if (!sink || opts?.suppressStepStream) return false;
  return step === 0 || (opts?.conversational === true && finalStreamSafe(st));
}

/**
 * Вызов модели со стримом в sink. §10: на разговорном ходе фраза уходит сразу (mouth-to-ear = первый токен + одна
 * фраза); на action-пути — только когда накопилось ≥ 2 фраз (преамбулу «Сейчас гляну…» перед tool_use не голосим).
 *   - ПЕРВАЯ отдача раунда сверяется с капитуляцией: «Не могу…» не звучит, раунд замолкает целиком — анти-капитуляция
 *     переспросит модель, и в голос уйдёт уже повтор (иначе владелец слышал бы отказ и следом ответ);
 *   - текстовый ход без tool_use: остаток дофлашиваем, streamedFinal = что-то реально ушло (терминал не дублирует);
 *   - tool-ход: удержанное (преамбулу) отбрасываем, финал произнесёт следующий раунд или терминал.
 */
export async function streamModelCall(ctx: LoopCtx, llmReq: LlmRequest): Promise<LlmResponse> {
  const { deps, opts, st } = ctx;
  const sink = ctx.sink as ReplySink;
  const chunker = new SentenceChunker();
  const held: string[] = [];
  let eager = opts?.conversational === true;
  let muted = false;
  const release = (pieces: string[]): void => {
    if (muted || pieces.length === 0) return;
    if (!st.progress.streamedThisRound && looksLikeGiveUp(pieces.join(" "))) {
      muted = true;
      return;
    }
    for (const p of pieces) emitSentence(sink, p);
    st.progress.streamedThisRound = true;
    st.progress.spokeAny = true;
  };
  const onPiece = (raw: string): void => {
    if (eager) return release([raw]);
    held.push(raw);
    if (held.length >= 2) {
      release(held.splice(0));
      eager = true;
    }
  };
  const resp = await deps.llm.completeStream(llmReq, (d) => {
    for (const raw of chunker.push(d.text)) onPiece(raw);
  });
  if (resp.toolUses.length === 0) {
    for (const raw of chunker.flush()) onPiece(raw);
    release(held.splice(0)); // конверсация в 1 фразу (action-путь) — отдаём её сейчас
    st.progress.streamedFinal = st.progress.streamedThisRound;
  }
  return resp;
}
