// W3 «Петля»: завершение задачи: самообучение, расход, исход навыка, макрос, метрики.
import { selfLearnSkill } from "./self-learn.js";
import { log } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { LoopOutcome } from "./outcome.js";
import { compileReplayLines } from "../../../memory/skill-macro.js";
import { metrics } from "../../../obs/metrics.js";
import { costUsd } from "../../../obs/pricing.js";

/** Порог сырого косинуса, с которого вспомненный навык считается «той же задачей» (исход и макрос — ему). */
export const CONFIDENT_RECALL_RAW_COS = 0.9;

/** Уверенный recall: есть сырой косинус и он ≥ порога. Лексический recall (без косинуса) уверенным не считается. */
export function confidentRecall(r: { recallSimRaw?: number } | null | undefined): boolean {
  return typeof r?.recallSimRaw === "number" && r.recallSimRaw >= CONFIDENT_RECALL_RAW_COS;
}

export async function maybeSelfLearn(ctx: LoopCtx, o: LoopOutcome): Promise<void> {
  const { deps, tier, st, taskId, recalled, sys, convo, toolCtx } = ctx;
  const { taskOk } = o;
  const learnWorthy = st.progress.round >= 3 || (st.progress.wasResearched && st.progress.round >= 1);
  // 🔴 Гейт по `taskOk` (контроль-5): прежний ручной список неуспехов расходился с истиной — в нём не
  // было ни `floodStuck` (его брат `runawayStuck` стоял!), ни `queueTimedOut`/`channelLost`/
  // `maskedFailure`. Итог: на флуд-провале рефлексия на Opus утверждала «Задача решена за N шагов» и
  // сохраняла навык из траектории, которая НЕ привела к результату — recall потом подсовывал бы её.
  // `taskOk` — единственный полный список; новый флаг больше не забудется.
  // T-F1: смоук агента не учит навыки владельца.
  if (!deps.devSession && taskOk && st.progress.finalText && st.honesty.anyToolSucceeded && learnWorthy && !recalled && !st.progress.skillSavedInLoop && deps.skills) {
    const learnedId = await selfLearnSkill({
      deps,
      sys,
      convo,
      finalText: st.progress.finalText,
      round: st.progress.round,
      toolTrajectory: st.progress.toolTrajectory,
      toolCtx,
      // Само-обучение — КЛЮЧЕВАЯ способность Джарвиса, и качество выученной процедуры
      // компаундится: плохой навык отравит recall на будущие задачи. Операция редкая
      // (только после успешной многошаговой задачи, round≥3), поэтому синтезируем навык на
      // СИЛЬНОМ тире — не экономим. Учиться надо умно, а не «как дешёвая модель».
      tier: "fable",
      model: deps.models.fable,
      taskId,
      wasResearched: st.progress.wasResearched,
    }).catch((e) => {
      log.debug("self-learn навыка пропущен", e instanceof Error ? e.message : String(e));
      return null;
    });
    if (learnedId) st.progress.savedSkillId = learnedId; // §8 МАКРОС: реплей допишется в свежевыученный навык
  }
}

export function recordTaskMetrics(ctx: LoopCtx, o: LoopOutcome): void {
  const { deps, tier, st, taskId, recalled, loopMaxMs } = ctx;
  const { capExhausted, inputDeniedFailure, overlayDeniedFailure, taskOk } = o;
  deps.spend.finishTask(taskId);
  if (st.usage.cacheReadTokens + st.usage.cacheCreationTokens > 0) {
    log.info("prompt-кеш (§15)", { cacheReadTokens: st.usage.cacheReadTokens, cacheCreationTokens: st.usage.cacheCreationTokens });
  }

  // §ErrorVoice: ложное «Готово» при сплошном провале инструментов — считаем ошибкой и для телеметрии
  // (вычисляем здесь, ниже переиспользуем в терминале). См. анти-ложное-«Готово» ниже.
  // P0.1: masked-failure по anyMutateSucceeded (не anyToolSucceeded) — пустое «Готово» после одних лишь
  // нейтральных вызовов (web_search и т.п.) тоже ложный успех: дело (мутация) не сделано.
  // НО не на ВОПРОСЕ (conversational): там «дела» (mutate) не ожидается вовсе, и «Не вышло — действие
  // не сработало» на невинный вопрос — ложь в обратную сторону (живой смоук 2026-07-02: «сколько будет
  // 2+2» + tool_load → пустой финал → «Не вышло»). Вопрос с полым финалом лечится emptyFinalNudged выше.
  // ПРОД-ТЕЛЕМЕТРИЯ (obs/metrics): per-task событие — токены/стоимость/латентность/раунды/тир/успех.
  // ok=false на любом неуспехе (исключение/лимит/таймаут/отмена/маскированный провал). Запись + одна
  // читаемая лог-строка «task-метрики» — чтобы видеть стоимость и латентность задачи в логах.
  const taskUsage = {
    inputTokens: st.usage.inputTokensTotal,
    outputTokens: st.usage.outputTokensTotal,
    cacheReadTokens: st.usage.cacheReadTokens,
    cacheCreationTokens: st.usage.cacheCreationTokens,
  };
  // H2/H4: стаб LLM и топтание на одном действии — тоже НЕ успех (метрики ok=false, макрос не пишем).
  // §Волна2 (2.5, ревью): таймаут admission-очереди — тоже провал (иначе метрики ok:true на «не приступил»).
  // Ревью волны Б 2-й проход (#4): обрыв канала ПК (channelLost) и исчерпание шагов без ответа
  // (capExhausted) — тоже НЕ успех (иначе прерванная обрывом задача писалась бы ok:true в метрики).
  // 5-й проход (#2): исключение — capAnswered (разговорный ход с воскрешённым ответом) — это УСПЕХ
  // (ответ реально отдан), метрики/статус согласованы с озвученным терминалом.
  const latencyMs = Date.now() - st.budget.loopStartMs;

  // P2.3 НАДЁЖНОСТЬ НАВЫКА: задача шла с recall'нутым выученным навыком → записываем исход. Провал копит
  // fail_count (навык перестанет подсовываться recall'ом), успех гасит. ТОЛЬКО СВОЙ навык (общую надёжность
  // не трогаем — это админ-решение §мультитенант). Отмену/лимит/таймаут НЕ считаем провалом навыка (не его
  // вина) — учитываем лишь реальный исход (успех / failed / маскированный провал).
  // H2: стаб LLM — не вина навыка, исход не записываем (иначе сетевой блип копит fail_count).
  // Ревью волны Б 2-й проход (#4): обрыв канала ПК (channelLost) — ТОЖЕ не вина навыка (тот же класс,
  // что стаб LLM): иначе N сетевых блипов подряд копят fail_count и recall перестаёт подсовывать
  // ИСПРАВНЫЙ навык. capExhausted (исчерпал шаги без ответа) — исход неоднозначен, навыку не кредитуем.
  // Ревью 2026-09-02: отказ АРЕНДЫ ВВОДА — тот же класс «не дали работать», что queueTimedOut: навык
  // не запускался ни на шаг, а получал бы −1 (три параллельные задачи за мышь стирали бы исправный
  // навык из recall) либо, на пути реплея, ложный кредит успеха.
  // T-F3 (ревью 2026-09-24): исход кредитуем только УВЕРЕННО вспомненному навыку. Шумный recall e5 (sim 0.82–0.88 на
  // чужие задачи) раньше начислял исход не тому навыку — плохой навык не подавлялся, хороший штрафовался.
  // Контроль-1 №5: и навыку, чей авто-реплей реально исполнялся (порог реплея 0,84 ниже порога «уверенного» 0,9).
  if (!deps.devSession && (confidentRecall(recalled) || st.progress.macroReplayed) && recalled && !recalled.fromShared && deps.skills?.recordOutcome && !st.exit.cancelled && !st.exit.limited && !st.exit.timedOut && !st.exit.llmStubbed && !st.exit.queueTimedOut && !st.exit.channelLost && !capExhausted && !inputDeniedFailure && !overlayDeniedFailure) {
    void deps.skills.recordOutcome(deps.userId, recalled.id, taskOk).catch((e) =>
      log.debug("recordOutcome навыка пропущен", e instanceof Error ? e.message : String(e)),
    );
  }
  // §8 МАКРОС (generic, НЕ под конкретное приложение): задача решена УСПЕШНО руками (жесты в трассе) →
  // механически компилируем жесты в авто-реплей и вписываем в навык — recall'нутый СВОЙ ИЛИ только что
  // сохранённый в этой задаче (skill_save в петле / self-learn). Так ЛЮБОЕ UIA-слепое приложение
  // (игра/canvas) после первого успешного прогона получает макрос, и следующий recall исполняет его
  // за секунды без LLM-раундов. Успешный прогон ЧЕРЕЗ сам макрос жестов не оставляет (LLM только
  // сверял глазами) → перезаписи/version-churn нет.
  // T-F3: макрос вписывается в навык, сохранённый В ЭТОЙ задаче, или в уверенно вспомненный свой. Раньше целью был
  // любой recall — и жесты «напиши реферат» (клики в чат, набор текста) оседали слепым реплеем в чужих навыках.
  const macroTargetId =
    st.progress.savedSkillId ?? (recalled && !recalled.fromShared && confidentRecall(recalled) ? recalled.id : undefined);
  if (!deps.devSession && taskOk && macroTargetId && deps.skills?.attachReplay && st.progress.gestureTrace.length > 0) {
    const lines = compileReplayLines(st.progress.gestureTrace);
    if (lines.length > 0) {
      const skillsRef = deps.skills;
      void skillsRef
        .attachReplay!(deps.userId, macroTargetId, lines)
        .then((written) => {
          if (written) log.info("§8 макрос: жесты успешного прогона скомпилированы в авто-реплей", { id: macroTargetId, steps: lines.length });
        })
        .catch((e) => log.debug("§8 макрос: attachReplay пропущен", e instanceof Error ? e.message : String(e)));
    }
  }
  metrics.record({
    tier: st.tier.currentTier,
    // Модель, которая РЕАЛЬНО работала (резерв на подписке отвечает своей, не моделью тира).
    // По этому полю считается /cogs и «какой моделью это делалось» — оно обязано быть правдой.
    model: st.tier.modelUsedLast ?? st.tier.model,
    userId: deps.userId,
    latencyMs,
    rounds: st.progress.round,
    toolCalls: st.usage.toolCallsTotal,
    usage: taskUsage,
    ok: taskOk,
    // Деньги — РОВНО начисленные (ход по подписке = $0), а не пересчёт по прайсу API: на этих
    // событиях стоит /cogs, и фантомная стоимость превращала экономику продукта в выдумку.
    costUsd: st.usage.taskChargedUsd,
    // Канал хода — чтобы «быстрота» и цена резались по нему, а не гадались по имени модели.
    ...(st.tier.lastChannelUsed ? { channel: st.tier.lastChannelUsed } : {}),
    // Действовавший потолок: без него из телеметрии не отличить «не успел» от «упёрся в узкий потолок».
    capMs: loopMaxMs(),
    // Канал модели не ответил → это НЕ провал работы Джарвиса, и в статистике слабостей он не должен
    // выглядеть как «не справился» (разбор телеметрии 2026-08-31: 31 такой ход из 86 «провалов»).
    ...(taskOk ? {} : { failKind: st.exit.llmStubbed ? ("llm_unavailable" as const) : ("task" as const) }),
  });
  log.info("task-метрики", {
    tier: st.tier.currentTier,
    model: st.tier.modelUsedLast ?? st.tier.model, // кто РЕАЛЬНО отвечал (резерв — своя модель, не модель тира)
    latencyMs, // чистое время работы (очередь за арендой ВЫЧТЕНА — см. queueWaitMs)
    capMs: loopMaxMs(), // действующий потолок задачи (на резерве-подписке он ШИРЕ — раунд там дороже)
    queueWaitMs: st.budget.queueWaitMs, // сколько простояли в очереди за арендой ввода (Волна 1)
    rounds: st.progress.round,
    toolCalls: st.usage.toolCallsTotal,
    inputTokens: st.usage.inputTokensTotal,
    outputTokens: st.usage.outputTokensTotal,
    cacheReadTokens: st.usage.cacheReadTokens,
    cacheCreationTokens: st.usage.cacheCreationTokens,
    costUsd: Number(st.usage.taskChargedUsd.toFixed(6)), // ровно то, что начислено (подписка = $0), не пересчёт по прайсу
    ok: taskOk,
  });
}

export async function finalizeTask(ctx: LoopCtx, o: LoopOutcome): Promise<void> {
  await maybeSelfLearn(ctx, o);
  recordTaskMetrics(ctx, o);
}
