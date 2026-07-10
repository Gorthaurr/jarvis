/**
 * §Волна2 (2.7) — Пер-раундовый thinking: рассуждение там, где оно работает (план/нудж/
 * эскалация), и «silence-default» на механических раундах (реплей известной процедуры,
 * follow-up-сверка после слепого действия) — минус 2-5с и сотни output-токенов на раунд.
 *
 * ГРАБЛИ (жёсткие, из плана §4.7 и API):
 *  - Opus/fable: thinking НЕ выключаем никогда (adaptive — его рабочее рассуждение);
 *  - переключение off→on легально ТОЛЬКО на «текстовой границе» (хвост convo — текстовый
 *    нудж, не tool_result): при thinking включённом финальный assistant-ход перед tool_result
 *    ОБЯЗАН начинаться thinking-блоком — раунд, сгенерированный с off, его не имеет → HTTP 400;
 *  - при выключении thinking реплеенные thinking-блоки истории СТРИПАЮТСЯ (иначе API 400);
 *    это разовая перезапись rolling-префикса — поэтому политика ЛИПКАЯ по фазам, а не
 *    тумблер каждый раунд.
 *
 * Чистые функции — тестируются без сети.
 */
import type { Tier, ThinkingEffort } from "@jarvis/shared";
import type { LlmMessage } from "../../integrations/llm.js";

/** Состояние петли, релевантное решению о thinking ЭТОГО раунда. */
export interface RoundThinkingState {
  /** Номер раунда (0 = первый — план). */
  step: number;
  /** Базовый эффорт тира из конфига (deps.tierThinking[currentTier]). */
  base: ThinkingEffort | undefined;
  /** Текущий тир (после эскалаций/family-boost). */
  tier: Exclude<Tier, "tier0">;
  /** Есть recall'нутый навык — процедура известна, раунды механические. */
  hasRecalledSkill: boolean;
  /** Висит несверённое слепое действие — следующий раунд = «посмотри и подтверди» (механика). */
  blindMutatePending: boolean;
  /** Этот раунд идёт сразу после нуджа/эскалации — переосмысление, думаем полноценно. */
  nudgeBoost: boolean;
}

/** Включён ли thinking при данном эффорте (off/undefined = параметр не шлётся). */
export function thinkingEnabled(e: ThinkingEffort | undefined): boolean {
  return e !== undefined && e !== "off";
}

/**
 * Решить эффорт thinking для раунда. Возвращает базовый эффорт или "off".
 * Консервативно: всё, что не «заведомо механика», думает как настроено.
 */
export function decideRoundThinking(s: RoundThinkingState): ThinkingEffort | undefined {
  if (!thinkingEnabled(s.base)) return s.base; // конфиг выключил — не «включаем обратно»
  if (s.tier === "fable") return s.base; // ГРАБЛЯ Opus (§4.7): планирование/эскалацию не глушим
  if (s.nudgeBoost) return s.base; // после нуджа — переосмысление, полное рассуждение
  if (s.step === 0) return s.base; // первый раунд — план (даже с навыком: примерка процедуры к задаче)
  // Механика: процедура известна (recall) ИЛИ раунд — сверка после слепого действия.
  if (s.hasRecalledSkill || s.blindMutatePending) return "off";
  return s.base; // прочая середина задачи — как настроено (консервативно)
}

/**
 * Вырезать thinking/redacted_thinking-блоки из реплеенных assistant-ходов (обязательно при
 * выключении thinking — иначе HTTP 400). Мутирует convo; возвращает число вырезанных блоков.
 * Пустой assistant-content невозможен по построению (thinking всегда соседствует с text/tool_use),
 * но страховка от API 400 на пустом массиве стоит.
 */
export function stripThinkingBlocks(convo: LlmMessage[]): number {
  let removed = 0;
  for (const m of convo) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const before = m.content.length;
    m.content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    removed += before - m.content.length;
    if (m.content.length === 0) m.content = [{ type: "text", text: "…" }];
  }
  return removed;
}
