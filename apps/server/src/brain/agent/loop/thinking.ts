// W3 «Петля»: подготовка вызова модели: кеш-брейкпоинт и пер-раундовый thinking (§Волна2 2.7).
import { log, sharedWarmth, markCacheBreakpoint } from "./util.js";
import type { LoopCtx } from "./context.js";
import { decideRoundThinking, stripThinkingBlocks, thinkingEnabled } from "../thinking-policy.js";

export function prepareCall(ctx: LoopCtx, step: number) {
  const { deps, tier, st, recalled, convo } = ctx;
  const { roundThinkingEnabled } = ctx.cfg;
  // §15 СКОРОСТЬ: кешируем статичный префикс (персона+инструменты, большой) ВСЕГДА, с первого
  // хода. Голосовая сессия — всегда разговор (многоходовой), так что кеш-запись (1.25× один раз
  // на ход 0) окупается мгновенно: со 2-го хода Opus не перечитывает огромный префикс → заметно
  // меньше время до первого токена. Прежний gate «греть только тёплую сессию» экономил копейки,
  // но держал первые ходы холодными (медленными) — для realtime это плохой размен.
  const warmth = deps.warmth ?? sharedWarmth;
  const cachePrefix = true;
  if (cachePrefix) markCacheBreakpoint(convo);

  // §Волна2 (2.7) ПЕР-РАУНДОВЫЙ THINKING: план/нудж/эскалация думают полноценно, механические
  // раунды (реплей известной процедуры, сверка после слепого действия) — без рассуждения
  // (−2-5с и сотни output-токенов на раунд). Opus/fable не глушится (грабля §4.7).
  const baseThinking = deps.tierThinking?.[st.tier.currentTier];
  let roundThinking = roundThinkingEnabled
    ? decideRoundThinking({
        step,
        base: baseThinking,
        tier: st.tier.currentTier,
        hasRecalledSkill: recalled !== null,
        blindMutatePending: st.honesty.blindMutatePending,
        nudgeBoost: st.tier.nudgeBoostNextRound,
      })
    : baseThinking;
  if (roundThinkingEnabled) {
    // API-легальность off→on: при включённом thinking assistant-ход с tool_use обязан нести свои
    // thinking-блоки — раунд, сгенерированный с off, их не имеет → на хвосте tool_result включать
    // нельзя (HTTP 400). Остаёмся off ещё раунд; поднимемся на ближайшей текстовой границе (нудж).
    const tail = convo[convo.length - 1];
    const tailIsToolResult = Boolean(
      tail && tail.role === "user" && Array.isArray(tail.content) && tail.content.some((b) => b.type === "tool_result"),
    );
    const forcedOff = thinkingEnabled(roundThinking) && !st.tier.prevThinkingOn && tailIsToolResult;
    if (forcedOff) roundThinking = "off";
    // Ревью Волны 2 (анти-рэчет): желание «подумать» (нудж/эскалация), сорванное API-ограничением,
    // ДЕФЕРИТСЯ — не потребляем nudgeBoost, поднимем thinking на ближайшей легальной границе.
    if (!forcedOff) st.tier.nudgeBoostNextRound = false;
    // Выключение после thinking-раундов: реплеенные thinking-блоки истории стрипаются (иначе 400).
    // Разовая перезапись префикса — политика липкая по фазам, не тумблер (WARN 1.8 покажет причину).
    if (!thinkingEnabled(roundThinking) && st.tier.prevThinkingOn) {
      const removed = stripThinkingBlocks(convo);
      if (removed > 0) log.debug("§2.7: thinking off — реплеенные thinking-блоки вырезаны", { removed, step });
    }
    st.tier.prevThinkingOn = thinkingEnabled(roundThinking);
  } else {
    st.tier.nudgeBoostNextRound = false;
  }
  return { roundThinking, warmth, cachePrefix };
}

export type CallPrep = ReturnType<typeof prepareCall>;
