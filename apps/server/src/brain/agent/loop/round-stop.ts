/**
 * W2 (П4, G-8): СТОП РАУНДА. Модель шлёт раунд «шагами вслепую» — [act type «Поиск», act key Enter]. Если первый шаг
 * не удался (не нашёл поле, исход неизвестен, §14 отклонён, вуаль, канал), второй бьёт по НЕ ТОМУ состоянию: Enter уходит
 * в чужое поле или в чат. Поэтому после провалившейся МУТАЦИИ остальные мутации раунда не исполняются — вместо них
 * честная заглушка `is_error` «не исполнен — перепланируй по факту».
 *
 * Заглушка — не ошибка модели и не попытка: в roundErrors, §7-эскалацию и семейный счёт она не идёт (round-classify
 * смотрит `skippedIds`), журнал чекпойнта пишет «НЕ ИСПОЛНЯЛСЯ» (`st.honesty.skippedCalls`), а не «ОШИБКА».
 * Чтение/verify/нейтральные вызовы раунда исполняются как обычно (снимок после провала — ровно то, что нужно);
 * параллельный read-only раунд (prefetch) мутаций не содержит — его стоп не касается.
 */
import type { LoopCtx } from "./context.js";
import type { RoundResult } from "./round-result.js";
import type { ToolResult } from "../../tools/dispatch.js";
import type { LlmResponse } from "../../../integrations/llm.js";

type ToolUse = LlmResponse["toolUses"][number];
type Effect = "verify" | "mutate" | "neutral";

/** Текст заглушки (модель читает его вместо результата; журнал по нему не судит — у него свой признак). */
export const SKIPPED_RESULT =
  "НЕ ИСПОЛНЕН: предыдущий шаг этого раунда не удался (ошибка / исход неизвестен / отклонён) — этот вызов не выполнялся, " +
  "ничего не изменено. Перепланируй по факту: сверь состояние и реши заново, повторять раунд вслепую нельзя.";

/** Исход вызова, после которого мутации раунда дальше не идут. `unchecked`/`met` у act — не провал. */
export function stopsRound(r: Pick<ToolResult, "isError" | "uncertain" | "declined" | "overlayDenied" | "channelDown">, eff: Effect): boolean {
  if (eff !== "mutate") return false;
  return r.isError || r.uncertain === true || r.declined === true || r.overlayDenied === true || r.channelDown === true;
}

/** Запомнить стоп: первая провалившаяся мутация раунда. */
export function noteRoundStop(round: RoundResult, tu: ToolUse, r: Parameters<typeof stopsRound>[0], eff: Effect): void {
  if (round.stoppedBy === undefined && stopsRound(r, eff)) round.stoppedBy = tu.id;
}

/**
 * Перед исполнением: мутация после стопа → заглушка вместо вызова (аренду ввода не берём, в сайдкар ничего не уходит).
 * true — вызов пропущен, результат уже в раунде.
 */
export function skipAfterStop(ctx: LoopCtx, tu: ToolUse, round: RoundResult): boolean {
  if (round.stoppedBy === undefined || ctx.effectOf(tu.name, tu.input) !== "mutate") return false;
  round.skippedIds.add(tu.id);
  ctx.st.honesty.skippedCalls.add(tu.id);
  round.resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: SKIPPED_RESULT, is_error: true });
  return true;
}
