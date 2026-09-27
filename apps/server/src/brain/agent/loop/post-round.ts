// W3 «Петля»: после результатов: подсказка лестницы, коммит раунда/журнал, обрыв канала, эскалация, anti-runaway, счёт раунда.
import { log, estimateResultTokens, CHANNEL_WAIT_MS, waitForChannel, emitTaskStatus } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { RoundResult } from "./tool-round.js";
import type { RoundTiming } from "./round-snapshot.js";
import { summarizeRound } from "./round-classify.js";
import { tradingEscalation, escalateOnFailedRound } from "./tiering.js";
import { antiRunawayIdentical, familyCap } from "./anti-runaway.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { pruneStaleImages } from "../prune-images.js";
import { buildResumeDigest, mergeDigests } from "../checkpoint.js";

export function ladderHint(ctx: LoopCtx): void {
  const { st, pushSystemNote } = ctx;
  // Подсказка лестницы — ПОСЛЕ результатов инструментов: теперь последнее сообщение user, и
  // appendUserNote допишет её в него, не разрывая пару assistant(tool_use)↔tool_result.
  if (st.nudge.ladderHintPending) {
    st.nudge.ladderHintPending = false;
    pushSystemNote(
      "Подсказка по лестнице восприятия: ты смотришь на экран КАРТИНКОЙ, ни разу не посмотрев СТРУКТУРУ. " +
        "look{what:\"elements\"} отдаёт элементы окна с ролью, именем, СОСТОЯНИЕМ (checked/expanded/value) и хендлом — " +
        "по ним act действует точно (по имени или handle) и сам сверяет исход; это в разы дешевле кадра и не требует " +
        "прицеливания по пикселям. Начинай оконные задачи с него; картинка нужна там, где структуры нет " +
        "(игра, canvas, нестандартный UI) — если look вернёт пусто, так и будет сказано, тогда картинка.",
    );
  }
}

export function commitRound(ctx: LoopCtx, resp: LlmResponse, round: RoundResult): void {
  const { deps, opts, st, taskId, convo, priorDigest, effectOf, saveCheckpoint } = ctx;
  const { KEEP_SCREENSHOTS, KEEP_SELECTION_VIEWS, KEEP_DOC_IMAGES } = ctx.cfg;
  // Волна C: результаты раунда УЖЕ в истории (мутации совершены) — даже если петля сейчас выйдет по
  // обрыву канала/отмене до `round += 1`, журнал чекпойнта обязан их включить.
  st.progress.committedToolRounds += 1;
  // Волна E (контроль-ревью): после 70%-нуджа страховочный снимок ОСВЕЖАЕТСЯ каждым закоммиченным
  // раундом — фаза «заверши подшаг» (последние 30% бюджета) как раз и делает финальную отправку, и
  // одноразовый снимок с 70% её бы НЕ содержал: «доделай» после жёсткого kill повторил бы отправку
  // человеку. Дёшево: работает только после нуджа. savedAt/offeredAt refreshJournal не трогает;
  // для свежей задачи слот уже наш (слот-гард пройден на нудже) — перезаписываем свежей версией.
  if (st.budget.budgetNudged && deps.checkpoints) {
    try {
      if (opts?.resumeFrom) {
        deps.checkpoints.refreshJournal(
          deps.userId,
          opts.resumeFrom.taskId,
          mergeDigests(priorDigest, buildResumeDigest(convo, { systemNotes: st.progress.systemNotes, effectOf, confirmedSends: st.honesty.confirmedSends, declinedCalls: st.honesty.declinedCalls, uncertainCalls: st.honesty.uncertainCalls, partialCalls: st.honesty.partialCalls })),
          Math.max(st.progress.round + 1, st.progress.committedToolRounds),
        );
      } else if (st.budget.preventiveCheckpoint) {
        // Контроль-2 волны E: слот-гард ПЕРЕПРОВЕРЯЕТСЯ на каждом re-save — параллельная задача
        // могла УЖЕ положить свой чекпойнт и ВСЛУХ пообещать «доделай» (терминал прерывания);
        // перетирание страховкой уничтожило бы озвученное обещание (store.save лишь WARN'ит).
        // Чужой слот → уступаем и выключаем страховку (наш clearIf в finally чужого не тронет).
        const slot2 = deps.checkpoints.peek(deps.userId);
        if (!slot2 || slot2.taskId === taskId) st.budget.preventiveCheckpoint = saveCheckpoint("hardKill", { deliverable: false });
        else st.budget.preventiveCheckpoint = false;
      }
    } catch (e) {
      log.warn("не удалось освежить страховочный журнал", { taskId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // PROACTIVE-гард (аудит 2026-07-20): оцениваем токены tool_result'ов ЭТОГО раунда — они попадут в
  // СЛЕДУЮЩИЙ промпт, но ещё не учтены в lastPromptTokens. Гард след. итерации сложит их с реальным
  // размером и свернётся ДО пробоя окна. Оценка КОНСЕРВАТИВНАЯ (over-estimate безопасен: ранний честный
  // свёрток, не 400). Прунинг старых скринов (ниже) только УМЕНЬШАЕТ след. промпт → проекция остаётся
  // верхней границей.
  st.budget.pendingResultTokens = estimateResultTokens(round.resultBlocks);
  // §адаптация к цели: помним, была ли в ПОСЛЕДНЕМ инструментальном раунде сверка глазами.
  if (resp.toolUses.length > 0) st.honesty.lastRoundHadVerify = round.sawVerifyThisRound;

  // §скорость (зрение): старые скрины — вон из контекста (см. prune-images.ts: токены, TTFT, кеш).
  const prunedImages = pruneStaleImages(convo, KEEP_SCREENSHOTS, KEEP_DOC_IMAGES, KEEP_SELECTION_VIEWS);
  if (prunedImages > 0) {
    st.budget.prunedLastRound = true; // диагностика кеша (1.8): prune мутирует историю → перезапись префикса
    log.debug("зрение: устаревшие скрины вырезаны из контекста", { pruned: prunedImages });
  }
}

export async function handleChannelDown(ctx: LoopCtx, round: RoundResult): Promise<"break" | "continue" | "next"> {
  const { session, st, task, taskId } = ctx;
  // Б4 (г/д): раунд не прошёл из-за МЁРТВОГО КАНАЛА (сокет ПК отвалился в resume-grace), не из-за
  // слабой модели. (д) НЕ эскалируем и НЕ трогаем streak — «лечить транспорт Opus'ом» = сжигание
  // денег (форензика: зомби-петли + Opus «от транспорта»). (г) ЖДЁМ переподключения (клиент шлёт
  // resumeSessionId, rebind вернёт сокет) вместо слепого продолжения; вернулся — повторяем раунд той
  // же моделью, не вернулся за окно — честный терминал (задача прервана обрывом).
  if (round.roundChannelDown) {
    const waited = await waitForChannel(session, CHANNEL_WAIT_MS, task);
    if (task.cancel.cancelled) {
      st.exit.cancelled = true;
      return "break";
    }
    if (!waited) {
      log.warn("agent-loop: канал не вернулся за окно ожидания — прерываю задачу (обрыв связи)", { taskId });
      st.exit.channelLost = true;
      return "break";
    }
    log.info("§Б4: канал восстановлен — продолжаю задачу той же моделью", { taskId, round: st.progress.round });
    return "continue"; // повторяем раунд (модель переотправит команды по is_error tool_result)
  }
  return "next";
}

export async function finishRound(ctx: LoopCtx, resp: LlmResponse, round: RoundResult, timing: RoundTiming): Promise<"break" | "continue" | "next"> {
  const { session, st, task, taskId, tasks } = ctx;
  const { stepStartedMs, stepQueueWait0, stepIdleWait0 } = timing;
  ladderHint(ctx);
  commitRound(ctx, resp, round);
  tradingEscalation(ctx, resp);
  const channel = await handleChannelDown(ctx, round);
  if (channel !== "next") return channel;
  const summary = summarizeRound(resp, round);
  st.tier.cleanRoundsStreak = summary.anyErrored ? 0 : st.tier.cleanRoundsStreak + 1;
  escalateOnFailedRound(ctx, summary, round);
  if (antiRunawayIdentical(ctx, summary) === "break") return "break";
  if (familyCap(ctx) === "break") return "break";
  st.progress.round += 1;
  // Ревью #5: блокирующее ожидание wait_for(browser) НЕ тикает в потолок задачи (как очередь аренды) —
  // loopStartMs УЖЕ сдвинут при аккумуляции выше (устойчиво к continue/break). Здесь только вычитаем
  // idle из средней длительности раунда, чтобы долгое «жди 26:00» не раздувало avgRoundMs (иначе
  // early-wrap срубал бы задачу до перемотки). loopStartMs тут НЕ трогаем (двойного сдвига нет).
  const roundIdleMs = st.budget.idleWaitMs - stepIdleWait0;
  st.budget.roundDurTotalMs += Math.max(0, Date.now() - stepStartedMs - (st.budget.queueWaitMs - stepQueueWait0) - roundIdleMs);
  tasks.progress(taskId, st.progress.round);
  if (st.progress.shown) emitTaskStatus(session, task);
  return "next";
}
