// W3 «Петля»: вызов модели (стрим — stream-final.ts), учёт usage/денег/телеметрии раунда, стаб.
import { log } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { CallPrep } from "./thinking.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { shouldStreamStep, streamModelCall } from "./stream-final.js";
import { verbalize } from "../../verbalize/index.js";
import { metrics } from "../../../obs/metrics.js";
import { chargedCostUsd, usageChannel } from "../../../obs/pricing.js";

export async function callModel(ctx: LoopCtx, step: number, prep: CallPrep) {
  const { deps, session, st, taskId, sys, convo } = ctx;
  const { roundThinking, warmth, cachePrefix } = prep;
  const llmReq = {
    tier: st.tier.currentTier,
    model: st.tier.model,
    systemStatic: sys.staticPrefix,
    systemSkill: sys.skillSuffix || undefined, // §8: навык — свой кеш-брейкпоинт (см. buildSystemBlocks)
    systemTools: st.arsenal.systemTools, // §15: каталог холодных инструментов — отдельный кешируемый блок (ленивая загрузка)
    systemDynamic: sys.dynamicSuffix || undefined,
    messages: convo,
    tools: st.arsenal.tools,
    cachePrefix,
    // §7 «эффорт» по тиру → thinking (модель-aware в anthropic); §Волна2 (2.7) — с пер-раундовым
    // override (off на механике). При эскалации currentTier меняется → меняется и эффорт.
    thinking: roundThinking,
    // W2: одна сессия модели на задачу (провайдер подписки держит диалог между раундами; release — в finally).
    sessionKey: taskId,
    // W3 (L-6): петля переписала УЖЕ отправленную историю (свёртка/вырезка скринов) — провайдер с живой сессией
    // сам решает, начать ли её заново со свёрнутым транскриптом (иначе свёртка не уменьшает реальный промпт).
    ...(st.budget.maskedLastRound ? { historyRewritten: "masked" as const } : st.budget.prunedLastRound ? { historyRewritten: "pruned" as const } : {}),
  };
  // §10 realtime + W3 (V-4): стрим — шаг 0 и финал разговорного хода без дел (stream-final.ts). SYNC-FIRST (фикс
  // double-speak): при suppressStepStream посреди петли в sink не уходит НИЧЕГО — финал звучит один раз: в терминале
  // (done) или через speakResult (промоушен). streamedThisRound — что-то из ЭТОГО вызова уже прозвучало.
  st.progress.streamedThisRound = false;
  st.progress.streamedFinal = false;
  const llmCallStartedMs = Date.now(); // время ИМЕННО обращения к модели — для замера быстроты канала
  const resp: LlmResponse = shouldStreamStep(ctx, step) ? await streamModelCall(ctx, step, llmReq) : await deps.llm.complete(llmReq);
  warmth.touch(session.sessionId);
  deps.spend.recordStep(taskId);
  return { resp, llmCallStartedMs };
}

export function accountRound(ctx: LoopCtx, step: number, resp: LlmResponse, llmCallStartedMs: number): void {
  const { deps, tier, st, taskId } = ctx;
  // 🔴 Волна G/H (живой прогон): ход по ПОДПИСКЕ не тарифицируется по токенам — она оплачена
  // помесячно. Считать его в долларовый расход API нельзя: фиктивные $0.8/ход съедали месячный
  // потолок SpendGuard и заблокировали бы работу. Токены учитываем (это реальный расход лимита
  // подписки и полезная телеметрия), деньги — нет.
  const turnCostUsd = chargedCostUsd(resp, st.tier.model);
  st.usage.taskChargedUsd += turnCostUsd; // фактически начисленные деньги задачи — для /cogs (см. metrics.record ниже)
  // Кто ответил НА САМОМ ДЕЛЕ: у резерва модель своя, у основного канала — модель тира.
  st.tier.modelUsedLast = resp.modelUsed ?? st.tier.model;
  st.tier.lastChannelUsed = usageChannel(resp);
  deps.spend.recordUsage(taskId, resp.usage.inputTokens + resp.usage.outputTokens, turnCostUsd);
  deps.usageSink?.({
    taskId, round: st.progress.round, model: st.tier.modelUsedLast, usage: resp.usage, costUsd: turnCostUsd, kind: "turn", channel: usageChannel(resp),
    stubbed: resp.stopReason === "stub", promptTokensEstimate: st.budget.lastPromptTokens,
  });
  st.usage.cacheReadTokens += resp.usage.cacheReadTokens;
  st.usage.cacheCreationTokens += resp.usage.cacheCreationTokens;
  // Телеметрия: вход/выход за ход (cache_* копятся отдельно выше) + число вызовов инструментов.
  st.usage.inputTokensTotal += resp.usage.inputTokens;
  st.usage.outputTokensTotal += resp.usage.outputTokens;
  st.usage.toolCallsTotal += resp.toolUses.length;
  // Гард контекст-окна: реальный размер ТОЛЬКО ЧТО отправленного промпта (весь вход = не-кеш + чтение из
  // кеша + запись в кеш). Проверяется в блоке бюджета на следующей итерации (watermark прошлого раунда).
  st.budget.lastPromptTokens = resp.contextTokens ?? (resp.usage.inputTokens + resp.usage.cacheReadTokens + resp.usage.cacheCreationTokens);
  // PROACTIVE-гард: этот usage УЖЕ включает результаты прошлого раунда → сбрасываем их оценку; результаты
  // ТЕКУЩЕГО раунда (ещё не отправленные) будут оценены после их формирования (см. ниже, у convo.push).
  st.budget.pendingResultTokens = 0;
  // Волна 1 (1.8): пер-раундовая телеметрия + WARN на перезапись кеш-префикса С ПРИЧИНОЙ. Норма
  // rolling-кеша: read >> creation (пишется только свежий хвост); creation > read = префикс
  // перезаписан (в эпизоде 2026-07-10 это съело $0.63 из $1.04 и было НЕВИДИМО в per-task метриках).
  {
    const thrash = step > 0 && resp.usage.cacheCreationTokens > 1000 && resp.usage.cacheCreationTokens > resp.usage.cacheReadTokens;
    const thrashCause = thrash
      ? st.tier.model !== st.tier.prevRoundModel
        ? "model-switched"
        : st.budget.maskedLastRound
          ? "masked-observations" // волна C: свёртка старых дампов — САМАЯ дорогая причина, её не прячем за prune скринов
          : st.budget.prunedLastRound
            ? "pruned-images"
            : "prefix-changed"
      : undefined;
    if (thrash) {
      log.warn("prompt-кеш: перезапись префикса в раунде (§15)", {
        step,
        cacheCreationTokens: resp.usage.cacheCreationTokens,
        cacheReadTokens: resp.usage.cacheReadTokens,
        cause: thrashCause,
      });
    }
    metrics.recordRound({
      taskId,
      round: step,
      tier: st.tier.currentTier,
      // Модель и деньги — ФАКТИЧЕСКИЕ: резерв отвечает своей моделью и не тарифицируется по токенам.
      model: st.tier.modelUsedLast ?? st.tier.model,
      usage: resp.usage,
      costUsd: turnCostUsd,
      // Время ИМЕННО этого раунда и канал — по ним меряется «быстрота» (запрос владельца
      // 2026-09-02): на резерве раунд стоит секунды, на кешированном основном — доли секунды.
      latencyMs: Math.max(0, Date.now() - llmCallStartedMs),
      channel: usageChannel(resp),
      toolNames: resp.toolUses.map((t) => t.name),
      ...(thrashCause ? { cacheThrashCause: thrashCause } : {}),
    });
    st.tier.prevRoundModel = st.tier.model;
    st.budget.prunedLastRound = false;
    st.budget.maskedLastRound = false;
  }
}

export function noteStub(ctx: LoopCtx, resp: LlmResponse): "break" | "next" {
  const { st } = ctx;
  // H2: аварийный стаб LLM — провал хода. Раньше стаб-текст («Связь прервалась… повторите»)
  // становился finalText → tasks.finish как успех (метрики ok=true), а ход без инструментов ещё и
  // кэшировался семантически → повтор вопроса крутил ошибку ИЗ КЭША уже после восстановления связи
  // («заевшая пластинка»). Терминал ниже честно проваливает задачу и не пишет кэш.
  if (resp.stopReason === "stub") {
    st.exit.llmStubbed = true;
    if (!st.progress.spokeAny) st.progress.streamedFinal = false; // ни фразы не прозвучало — терминал обязан озвучить провал
    // M5: стаб уже прозвучал в sink (step0-стрим отдал его текст пользователю) → терминал ОБЯЗАН
    // вернуть в память/чат ровно этот текст, а не другую фразу «связь прервалась» (иначе запись
    // расходится с произнесённым). Стрим проговорил verbalize(resp.text) пофразно (как штатный
    // конверсационный путь) и выставил streamedFinal — храним ту же вербализованную форму.
    if (st.progress.spokeAny && st.progress.streamedFinal) st.exit.stubSpokenText = verbalize(resp.text);
    return "break";
  }
  return "next";
}
