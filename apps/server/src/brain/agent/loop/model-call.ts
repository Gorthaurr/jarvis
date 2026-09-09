// W3 «Петля»: вызов модели (стрим на первом ходе), учёт usage/денег/телеметрии раунда, стаб.
import { log, emitSentence } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { CallPrep } from "./thinking.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { SentenceChunker } from "../../nlu/sentences.js";
import { verbalize } from "../../verbalize/index.js";
import { metrics } from "../../../obs/metrics.js";
import { costUsd } from "../../../obs/pricing.js";

export async function callModel(ctx: LoopCtx, step: number, prep: CallPrep) {
  const { deps, session, tier, sink, opts, st, taskId, sys, convo } = ctx;
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
  };
  // §10 realtime: на ПЕРВОМ ходе с sink стримим текст пофразно (token-streaming) — НО ТОЛЬКО
  // для многопредложенных конверсационных реплик (как в плане: «пофразный — для много-
  // предложенных, 1 фраза — текущий путь»). Claude штатно выдаёт ТЕКСТОВУЮ ПРЕАМБУЛУ перед
  // tool_use («Сейчас гляну…» → web_read); чтобы её НЕ озвучивать, держим первую фразу и
  // отдаём поток лишь когда накопилось ≥2 фразы (точно конверсация — преамбула коротка).
  //   - конверсация (нет tool_use): held дофлашиваем в конце, streamedFinal=true (терминал не дублирует);
  //   - tool-ход: held (преамбулу) ОТБРАСЫВАЕМ — финал произнесём в терминале ровно один раз.
  let resp: LlmResponse;
  const llmCallStartedMs = Date.now(); // время ИМЕННО обращения к модели — для замера быстроты канала
  // SYNC-FIRST (фикс ревью, double-speak): при suppressStepStream пофразный step-0-стрим ОТКЛЮЧЁН —
  // ничего не уходит в sink ПОСРЕДИ петли. Иначе для текстового action-ответа стрим ставил pushedAny в
  // пайплайне ДО промоушена → «Берусь» глох, а итог через speakResult звучал ВТОРОЙ раз (двойная озвучка).
  // Финал произносится ОДИН раз: в терминале (done) или через speakResult (промоушен). Первый-токен-стрим
  // не теряем для РАЗГОВОРА (conversational идёт обычным путём, там suppressStepStream не ставится).
  if (sink && step === 0 && !opts?.suppressStepStream) {
    const chunker = new SentenceChunker();
    const held: string[] = [];
    // W2 (2026-09-09): на РАЗГОВОРНОМ ходе первую фразу отдаём сразу — mouth-to-ear = первый токен + одна
    // фраза, а не вся генерация. Преамбула перед инструментом («Сейчас гляну…») тут и есть честная
    // обратная связь; финал tool-хода произносит терминал. На action-пути гард ≥2 фраз остаётся.
    let eager = opts?.conversational === true; // подтверждённый конверсационный режим → немедленная отдача
    const onPiece = (raw: string): void => {
      if (eager) {
        emitSentence(sink, raw);
        st.progress.spokeAny = true;
        return;
      }
      held.push(raw);
      if (held.length >= 2) {
        for (const h of held) emitSentence(sink, h);
        held.length = 0;
        eager = true;
        st.progress.spokeAny = true;
      }
    };
    resp = await deps.llm.completeStream(llmReq, (d) => {
      for (const raw of chunker.push(d.text)) onPiece(raw);
    });
    if (resp.toolUses.length === 0) {
      for (const raw of chunker.flush()) onPiece(raw);
      for (const h of held) emitSentence(sink, h); // конверсация в 1 фразу — отдаём её сейчас
      if (held.length > 0) st.progress.spokeAny = true;
      st.progress.streamedFinal = true;
    }
    // tool-ход: held + остаток чанкера отбрасываем (преамбулу не озвучиваем).
  } else {
    resp = await deps.llm.complete(llmReq);
  }
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
  const turnCostUsd = resp.channel === "subscription" ? 0 : costUsd(st.tier.model, resp.usage);
  st.usage.taskChargedUsd += turnCostUsd; // фактически начисленные деньги задачи — для /cogs (см. metrics.record ниже)
  // Кто ответил НА САМОМ ДЕЛЕ: у резерва модель своя, у основного канала — модель тира.
  st.tier.modelUsedLast = resp.modelUsed ?? st.tier.model;
  st.tier.lastChannelUsed = resp.channel === "subscription" ? "subscription" : "api";
  deps.spend.recordUsage(taskId, resp.usage.inputTokens + resp.usage.outputTokens, turnCostUsd);
  deps.usageSink?.({
    taskId, round: st.progress.round, model: st.tier.modelUsedLast, usage: resp.usage, costUsd: turnCostUsd, kind: "turn", channel: resp.channel === "subscription" ? "subscription" : "api",
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
  st.budget.lastPromptTokens = resp.usage.inputTokens + resp.usage.cacheReadTokens + resp.usage.cacheCreationTokens;
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
      channel: resp.channel === "subscription" ? "subscription" : "api",
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
