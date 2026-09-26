/**
 * W2 (пакет 0): опции журнала чекпойнта из состояния петли — ОДНА сборка на четыре места (post-round, terminal, guards,
 * checkpoint-save). Прежде одинаковый литерал был скопирован четырежды: новый сигнал честности (так было с
 * uncertainCalls/partialCalls) надо было не забыть в каждой копии — забытая копия = журнал «ок» о несделанном.
 */
import type { DigestOptions } from "../checkpoint.js";
import type { LoopState } from "./state.js";

export type EffectOf = NonNullable<DigestOptions["effectOf"]>;

export function digestOptions(st: LoopState, effectOf: EffectOf): DigestOptions {
  return {
    systemNotes: st.progress.systemNotes,
    effectOf,
    confirmedSends: st.honesty.confirmedSends,
    declinedCalls: st.honesty.declinedCalls,
    uncertainCalls: st.honesty.uncertainCalls,
    partialCalls: st.honesty.partialCalls,
    skippedCalls: st.honesty.skippedCalls, // W2: заготовка — наполняет стоп раунда (П4)
  };
}
