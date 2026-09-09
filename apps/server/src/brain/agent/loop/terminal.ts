// W3 «Петля»: терминалы задачи — упорядоченная таблица предикат → фраза (selectTerminal).
import { log, emitTaskStatus } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { AgentReply } from "../types.js";
import type { LoopOutcome } from "./outcome.js";
import { llmFailureLine } from "../../../integrations/anthropic.js";
import { buildResumeDigest, mergeDigests, resumeOfferPhrase } from "../checkpoint.js";
import { splitIntoSentences } from "../../nlu/sentences.js";
import { isHollowSuccess, looksLikeGiveUp, maskedFailureReply } from "../error-voice.js";
import { verbalize } from "../../verbalize/index.js";

export function makeTerminal(ctx: LoopCtx) {
  const { sink, st } = ctx;
  // §10 realtime: финальная реплика терминала в sink (если ещё не стримилась пофразно на
  // 1-м ходе). voice уже вербализован — режем на предложения для пофразного синтеза. На
  // конверсационном пути (streamedFinal) реплика уже отдана → не дублируем.
  const terminal = (voice: string): AgentReply => {
    if (sink && !st.progress.streamedFinal) for (const s of splitIntoSentences(voice)) sink.sentence(s);
    return { voice };
  };
  return terminal;
}

export interface TerminalEnv { terminal: (voice: string) => AgentReply; doneRounds: number }

export function refreshResumeJournal(ctx: LoopCtx): void {
  const { deps, opts, st, taskId, convo, priorDigest, effectOf } = ctx;
  // 🔴 Волна C (контрольное ревью, HIGH): если это ПРОДОЛЖЕНИЕ и заход успел поработать — журнал в
  // сторе обязан включать ЭТОТ заход, КАКИМ БЫ ни был терминал. Иначе комбинация двух фиксов давала
  // тихую ловушку: peek (не take) оставляет чекпойнт живым, а saveCheckpoint зовут лишь три терминала
  // «прерывания» — значит после провала/отмены/стаба в сторе лежал журнал ПРОШЛОГО захода, без свежих
  // отправок, и следующее «доделай» повторяло их людям. Предложение при этом НЕ переигрываем
  // (refreshJournal не трогает offeredAt) — обещания не было, окно у плеера ничего не отбирает.
  // Проделанная работа для ЧЕСТНЫХ формулировок: обрыв посреди раунда выходит из петли до `round += 1`,
  // а мутации уже совершены — говорить «сделано шагов: 0» при отправленном сообщении нельзя.
  if (opts?.resumeFrom && !st.exit.cancelled && st.progress.committedToolRounds >= 1 && deps.checkpoints) {
    try {
      deps.checkpoints.refreshJournal(
        deps.userId,
        opts.resumeFrom.taskId,
        mergeDigests(priorDigest, buildResumeDigest(convo, { systemNotes: st.progress.systemNotes, effectOf, confirmedSends: st.honesty.confirmedSends, declinedCalls: st.honesty.declinedCalls, uncertainCalls: st.honesty.uncertainCalls, partialCalls: st.honesty.partialCalls })),
        Math.max(st.progress.round, st.progress.committedToolRounds),
      );
    } catch (e) {
      log.warn("не удалось обновить журнал чекпойнта", { taskId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

  // Терминал задачи (§20): отмена / лимит / успех — со стримом task.status.
export function terminalCancelled(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { deps, session, opts, st, task, taskId } = ctx;
  const { terminal } = env;
  // 🔴 ОТМЕНА ГАСИТ ЧЕКПОЙНТ (контрольное ревью-2, HIGH): владельцу сказали «Остановил», значит
  // обещание продолжить больше не в силе. Иначе «доделай» (а внутри окна и голое «продолжи»,
  // сказанное ПЛЕЕРУ) в течение TTL воскрешало ЯВНО остановленную работу — и она снова кликала.
  if (deps.checkpoints) {
    if (opts?.resumeFrom) deps.checkpoints.clearIf(deps.userId, opts.resumeFrom.taskId);
    deps.checkpoints.clearIf(deps.userId, taskId);
  }
  // state уже "cancelled" (выставил router через tasks.cancel/cancelSession) — досылаем финальный статус.
  if (st.progress.shown) emitTaskStatus(session, task);
  // ТИХО (аудит 2026-07-02): ack отмены («Остановил.»/«Остановил все, сэр.») уже произносит
  // handleTaskControl ОДИН раз на всю команду. Раньше КАЖДАЯ отменённая фоновая петля ещё и
  // возвращала «Хорошо, остановил.» → speakResult → на двух задачах звучало дважды (живой случай:
  // «продолжи/продолжу видео на ютубе» → две петли → «Хорошо, остановил.» ×2). Терминал молчит.
  return terminal("");
}

  // §Волна2 (2.5): очередь не дождалась аренды — честный «не приступил», без вранья про шаги/время.
export function terminalQueueTimedOut(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks } = ctx;
  const { QUEUE_WAIT_MS } = ctx.cfg;
  const { terminal } = env;
  tasks.fail(taskId, `ввод занят другой задачей — очередь не дождалась аренды за ${Math.round(QUEUE_WAIT_MS / 1000)}с`);
  if (st.progress.shown) emitTaskStatus(session, task);
  return terminal(verbalize("Так и не приступил, сэр — мышь и клавиатура остались заняты другой задачей. Повторить, когда освобожусь?"));
}

export function terminalFailed(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks } = ctx;
  const { terminal } = env;
  tasks.fail(taskId, "ошибка выполнения задачи");
  if (st.progress.shown) emitTaskStatus(session, task);
  // Если часть ответа уже прозвучала — не противоречим «не смог», а мягко обозначаем заминку.
  return terminal(verbalize(st.progress.spokeAny ? "…на этом застопорился, сэр." : "Не смог выполнить — произошла ошибка."));
}

export function terminalLimited(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { deps, session, st, task, taskId, tasks } = ctx;
  const { terminal } = env;
  tasks.fail(taskId, "достигнут лимит на задачу (spend cap §14)");
  if (st.progress.shown) emitTaskStatus(session, task);
  // Продуктовый режим: потолок — квота ТАРИФА → говорим про кредиты (продлить/свой ключ), не «лимит».
  const quotaText = st.exit.limitedReason === "spend_cap" ? deps.quotaExhaustedText : undefined;
  if (quotaText) return terminal(verbalize(st.progress.spokeAny ? `…дальше остановился. ${quotaText}` : quotaText));
  // Аварийный стоп администратора — НЕ лимит задачи: назвать неверную причину значит отправить человека
  // покупать кредиты вместо разговора с администратором (живой прогон 2026-09-02).
  if (st.exit.limitedReason === "kill_switch")
    return terminal(verbalize(st.progress.spokeAny ? "…дальше остановился: работа приостановлена администратором." : "Работа приостановлена администратором, сэр — это не мой лимит."));
  return terminal(verbalize(st.progress.spokeAny ? "…дальше остановился — достигнут лимит." : "Остановился — достигнут лимит на задачу."));
}

  // Б4 (г): канал с ПК не вернулся за окно ожидания — задача прервана обрывом связи (НЕ провал модели,
  // НЕ ложное «Готово»). ok=false, семантический кэш не пишется (это не успешный ход).
export function terminalChannelLost(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks, saveCheckpoint } = ctx;
  const { terminal, doneRounds } = env;
  tasks.fail(taskId, `связь с ПК прервалась (сделано шагов: ${doneRounds})`);
  if (st.progress.shown) emitTaskStatus(session, task);
  // deliverable:false — канал к ПК мёртв по определению этой ветки, фраза-предложение до владельца
  // не дойдёт (Session.send в закрытый сокет молча выходит), поэтому окно у плеера не взводим.
  const canResume = saveCheckpoint("channelLost", { deliverable: false });
  const base = st.progress.spokeAny
    ? "…и тут связь с компьютером прервалась, сэр."
    : `Связь с компьютером прервалась, сэр — не довёл.${canResume ? "" : " Повторите, когда подключусь."}`;
  return terminal(verbalize(canResume ? `${base} ${resumeOfferPhrase()}` : base));
}

  // Ревью волны Б (#4): исчерпан лимит шагов, а ответа словами так и нет → честный провал, НЕ «Готово».
  // (порядок: после cancelled/failed/limited/channelLost, до успешного пути — это неуспех).
export function terminalCapExhausted(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, opts, st, task, taskId, tasks, saveCheckpoint } = ctx;
  const { terminal, doneRounds } = env;
  // 3-й проход (#5): модель УСПЕЛА дать реальный ответ, но нудж (goal-check/verify) обнулил finalText,
  // а переспросить не дал кап. Отдаём сохранённый ответ (это УСПЕХ, не ложное «не успел»).
  // 4-й проход (#1): ТОЛЬКО на РАЗГОВОРНОМ ходе. На action-задаче отвергнутый verify/goal-check текст
  // («Готово, музыка играет» на регион-блокнутой странице) воскрешать НЕЛЬЗЯ — это обход verify-петли.
  // Интеграционный проход (#6): + гард !blindMutatePending — разговорный ход С recall-навыком (оставлен
  // намеренно) может кликать GUI (input_click горячий) → blindMutatePending; если claim обнулён
  // verify-нуджем ИМЕННО из-за неснятой слепой сверки, воскрешать его = обход verify-LAW. Только когда
  // слепого долга нет.
  if (st.progress.lastAnswer && opts?.conversational && !st.honesty.blindMutatePending) {
    tasks.finish(taskId, st.progress.lastAnswer);
    if (st.progress.shown) emitTaskStatus(session, task);
    return terminal(verbalize(st.progress.lastAnswer));
  }
  tasks.fail(taskId, `исчерпан лимит шагов без ответа (${doneRounds} раундов)`);
  if (st.progress.shown) emitTaskStatus(session, task);
  const canResume = saveCheckpoint("stepCap");
  const base = opts?.conversational
    ? "Задумался и коротко ответить не успел, сэр — переспросите?"
    : st.progress.spokeAny
      ? "…на этом остановился, до ответа не довёл."
      : `Слишком много шагов без результата — остановился, сэр.${canResume ? "" : " Могу зайти иначе."}`;
  return terminal(verbalize(canResume && !opts?.conversational ? `${base} ${resumeOfferPhrase()}` : base));
}

export function terminalTimedOut(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks, saveCheckpoint } = ctx;
  const { terminal, doneRounds } = env;
  // Волна 1: в причину провала — сколько успели (панель/«что делал?» видят прогресс, не голый обрыв).
  tasks.fail(
    taskId,
    st.exit.contextWrap
      ? `свернулся заранее: контекст-окно почти исчерпано (сделано шагов: ${doneRounds})`
      : st.exit.earlyWrap
        ? `свернулся заранее: остаток времени меньше среднего раунда (сделано шагов: ${doneRounds})`
        : `превышен потолок времени задачи (сделано шагов: ${doneRounds})`,
  );
  if (st.progress.shown) emitTaskStatus(session, task);
  // Волна C: «Продолжить с того же места?» — обещание, которое до сих пор было ЛОЖНЫМ (продолжать
  // было нечем). Теперь оно звучит ТОЛЬКО когда чекпойнт реально лёг; иначе — прежняя честная
  // формулировка без обещания.
  const canResume = saveCheckpoint(st.exit.contextWrap ? "contextWrap" : st.exit.earlyWrap ? "earlyWrap" : "timeout");
  // Ревью: чекпойнт сохранялся и в ветке spokeAny, а предложение там НЕ звучало — окно приёма
  // «продолжи» взводилось молча и крало фразу у плеера. Сохранили → ОБЯЗАНЫ предложить.
  // Инвариант (контрольное ревью-2): база БЕЗ предложения, предложение — ОДНИМ хвостом по canResume.
  // Прежняя вложенность давала ветки, где чекпойнт сохранён (окно взведено), а предложение не звучит —
  // ровно тот дефект, что ловили у spokeAny. Так его больше негде получить.
  const base = st.exit.contextWrap
    ? st.progress.spokeAny
      ? "…дальше уже не помещалось в память задачи, остановил."
      : st.progress.round > 0
        ? `Задача разрослась и перестала помещаться в память, сэр — остановился, сделав ${doneRounds} шагов.${canResume ? "" : " Зайти по частям?"}`
        : `Слишком большой объём за раз — остановился, сэр.${canResume ? "" : " Зайти по частям?"}`
    : st.progress.spokeAny
      ? "…дальше затянулось, остановил."
      : st.progress.round > 0
        ? `Время вышло, сэр — остановился, сделав ${doneRounds} шагов, до конца не довёл.${canResume ? "" : " Повторить?"}`
        : `Долго не отвечало — остановил.${canResume ? "" : " Повторить?"}`;
  return terminal(verbalize(canResume ? `${base} ${resumeOfferPhrase()}` : base));
}

  // H2: LLM недоступен (аварийный стаб) — честный офлайн-провал: НЕ finish, НЕ кэш, ok=false.
export function terminalLlmStubbed(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks } = ctx;
  const { terminal } = env;
  tasks.fail(taskId, "LLM недоступен (аварийный стаб)");
  if (st.progress.shown) emitTaskStatus(session, task);
  // M5: стаб УЖЕ прозвучал в sink → память/чат обязаны совпасть с произнесённым. Возвращаем ровно
  // тот текст, что прозвучал (не перезаписываем другой фразой). terminal() при streamedFinal в sink
  // повторно не отдаёт — двойного голоса нет.
  if (st.exit.stubSpokenText) return terminal(st.exit.stubSpokenText);
  // Причина названа честно (кончился баланс ключа / ключ не принят / перегруз), а не «связь прервалась»
  // вслепую: живой прогон 2026-09-02 показал, что пользователь шёл чинить сеть при исчерпанном балансе.
  return terminal(verbalize(st.progress.spokeAny ? `…и тут не получилось: ${llmFailureLine()}` : llmFailureLine()));
}

  // H4: топтание на одном действии без результата — честный провал, а не «Готово».
export function terminalRunawayStuck(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks } = ctx;
  const { terminal } = env;
  tasks.fail(taskId, "повтор одного действия без видимого результата");
  if (st.progress.shown) emitTaskStatus(session, task);
  return terminal(verbalize(st.progress.spokeAny
    ? "…крутился на одном действии без видимого результата — остановился, сэр. Могу зайти иначе."
    : "Не уверен, что вышло, сэр: действие повторялось без видимого результата. Остановился — скажите, зайти другим способом?"));
}

  // §ErrorVoice анти-ложное-«Готово»: модель закрыла ход, но ВСЕ инструменты пали
  // (anyToolSucceeded=false при бывших попытках) и финал — пустое подтверждение → честно говорим о
  // провале, а не «Готово» на сбое. Содержательный ответ модели (не «Готово») не трогаем — доверяем.
  // (maskedFailure вычислен выше — рядом с телеметрией.)
export function terminalMaskedFailure(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks } = ctx;
  const { terminal } = env;
  tasks.fail(taskId, "инструменты не отработали");
  if (st.progress.shown) emitTaskStatus(session, task);
  log.info("§ErrorVoice: провал озвучен честно (ложное «Готово» перехвачено)", { trajectory: st.progress.toolTrajectory });
  return terminal(verbalize(maskedFailureReply(st.progress.spokeAny)));
}

  // 🔴 Флуд одним инструментом не остановился: это ПРОВАЛ с собственной формулировкой. Раньше флаг не
  // выставлялся вовсе, и ход уходил в УСПЕШНЫЙ терминал (ok=true в метриках; с волной C ещё и гасил
  // чекпойнт). ⚠️ Блок стоит ПОСЛЕ maskedFailure и дополнительно проверяет текст (контроль-5, HIGH):
  // `finalText` здесь — ПРЕАМБУЛА модели того раунда, и на «Готово.» мой первый вариант озвучивал
  // владельцу УСПЕХ при `failed` в реестре — то есть снимал работавший гард честности.
export function terminalFloodStuck(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { session, st, task, taskId, tasks } = ctx;
  const { terminal } = env;
  tasks.fail(taskId, `флуд инструментом «${st.exit.floodTool}» не остановился — задача не доведена`);
  if (st.progress.shown) emitTaskStatus(session, task);
  return terminal(
    verbalize(
      st.exit.floodTool
        ? `Застрял на «${st.exit.floodTool}» — не довёл, сэр. Нужен другой путь: скажите, как лучше.`
        : "Застрял на одном и том же и не довёл, сэр — нужен другой путь.",
    ),
  );
}

export function terminalSuccess(ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv): AgentReply {
  const { deps, session, text, opts, st, task, taskId, tasks } = ctx;
  const { injectedVerified, inputDeniedFailure, overlayDeniedFailure } = o;
  const { terminal } = env;
  if (!st.progress.finalText) st.progress.finalText = "Готово.";
  // Волна C: продолжение ДОВЕЛО задачу — журнал больше не нужен (иначе позднее «доделай» подняло бы
  // уже сделанное). clearIf, а не clear: за время работы параллельная задача могла занять слот своим
  // чекпойнтом — чужую недоделку успех этой задачи стирать не вправе.
  // Журнал недоделки гасит только УСПЕХ: ревью 2026-09-02 показало, что «доделай», упершееся в
  // занятый ввод, стирало журнал 18-раундовой работы — и следующее «доделай» получало «нечего
  // возобновлять», хотя система сама только что объявила заход неуспешным.
  if (opts?.resumeFrom && !inputDeniedFailure && !overlayDeniedFailure) deps.checkpoints?.clearIf(deps.userId, opts.resumeFrom.taskId);
  // 🔴 «Ввод не дали и ничего не сделано» — в РЕЕСТР это идёт провалом (разбор «Доты» 2026-09-02):
  // ход, вслух сказавший «Задача не выполнена», лежал как state:"done".
  // Реплику модели НЕ подменяем (она несёт подробности и частичный результат), но ДОПОЛНЯЕМ честной
  // оговоркой: ревью проверило прогоном, что maskedFailure тут НЕ страхует — «Готово, сэр — нажал
  // «Играть», поиск запущен» длиннее трёх слов, а «нажал» не входит в SUCCESS_VERB. Без оговорки
  // владелец слышал бы успех при провале в реестре.
  // Контроль-8 (input-denied-shadows-overlay): ветка аренды ввода стояла ПЕРВОЙ и перекрывала вуальную — про задачу,
  // где 3 шага и Enter УЖЕ ушли в GUI, владельцу говорили «не сделал» и называли не ту причину (по ней же группирует
  // провалы самодиагностика). Частичное исполнение важнее того, какая из двух причин «выиграла».
  const veilPartial = st.honesty.overlayPartialTotal > 0 || st.honesty.overlayActionInjected;
  if (inputDeniedFailure && !(overlayDeniedFailure && veilPartial)) {
    tasks.fail(taskId, "ввод занят другой задачей — действие не выполнено");
    st.progress.finalText = `${st.progress.finalText.trimEnd()} Нужное действие я при этом не сделал, сэр: ввод был занят другой задачей.`;
  } else if (overlayDeniedFailure) {
    // Контроль-3: вуаль оверлея не дала инжектировать ввод, и ничего не сделано — провал в реестре, не done.
    // Контроль-5 (V4-2): k шагов навыка/берста/макроса УЖЕ исполнено (в т.ч. Enter) — «не сделал» было бы ложью, по
    // которой владелец повторяет команду и получает дубль; причина в реестре и приписка называют k. Приписку не
    // дублируем, если модель уже честно сказала «не смог/жду» (V4-1); «действие ушло, исход неизвестен» — отдельно.
    const k = st.honesty.overlayPartialSteps;
    const total = st.honesty.overlayPartialTotal;
    const rest = st.honesty.overlayActionInjected ? "следующий шаг ушёл — исход не подтверждён" : "остальное не выполнено";
    const leaseAlso = inputDeniedFailure ? "; ввод при этом был занят другой задачей" : ""; // контроль-8: обе причины названы
    tasks.fail(
      taskId,
      (total > 0
        ? `поверх экрана была вуаль режима выделения — остановлено после ${k} выполненных шагов${total !== k ? ` (всего исполнено ${total})` : ""}, ${rest}`
        : st.honesty.overlayActionInjected
          ? "поверх экрана была вуаль режима выделения — действие ушло, исход не подтверждён"
          : "поверх экрана была вуаль режима выделения — действие не выполнено") + leaseAlso,
    );
    // Контроль-6 (C5R-6): одна связная приписка без противоречий («остальное — нет» и «ушёл» рядом не стоят).
    const veilTail = "сэр: поверх экрана была вуаль режима выделения.";
    // Контроль-10: ушедшее действие сверено чистым взглядом — отрицать его нельзя (ровно на этом владельцу говорили
    // «не сделал» про отправленное сообщение). Ход всё равно провален: отказанная вуалью мутация не состоялась.
    if (injectedVerified) {
      st.progress.finalText = `${isHollowSuccess(st.progress.finalText || "") ? "" : `${st.progress.finalText.trimEnd()} `}Ушедшее действие я сверил — оно прошло; а вот следующее под вуалью сделать не смог, ${veilTail}`;
    } else
    if (!looksLikeGiveUp(st.progress.finalText)) {
      // Контроль-7 (loop-3): полое «Сделано/Готово» модели терминал провала НЕ переиспользует (урок контроль-6 волны C) —
      // ведём своей честной фразой; содержательный текст оставляем и дописываем.
      const base = isHollowSuccess(st.progress.finalText || "") ? "" : `${st.progress.finalText.trimEnd()} `;
      st.progress.finalText =
        total > 0
          ? `${base}Часть шагов (${total}) я выполнил, и они не откатываются; ${st.honesty.overlayActionInjected ? "следующий шаг ушёл, но его исход не подтверждён — перед повтором сверю" : "остальное — нет"}, ${veilTail}`
          : st.honesty.overlayActionInjected
            ? `${base}Действие ушло, но его исход под вуалью не подтверждён — перед повтором сверю, ${veilTail}`
            : `${base}Нужное действие я при этом не сделал, ${veilTail}`;
    } else if (st.honesty.overlayActionInjected) {
      st.progress.finalText = `${st.progress.finalText.trimEnd()} Исход последнего шага не подтверждён — перед повтором сверю.`;
    }
  } else tasks.finish(taskId, st.progress.finalText);
  if (st.progress.shown) emitTaskStatus(session, task);
  const spokenFinal = verbalize(st.progress.finalText);
  // §15 семантический кэш: запоминаем ТОЛЬКО чисто-вербальный ход (НИ ОДНОГО инструмента → нет
  // побочных эффектов, реплей не соврёт «сделано»). store сам отсекает непригодные/командные запросы
  // (isCacheableQuery). Fire-and-forget — эмбеддинг async, не задерживает ответ.
  // ...и ЗАПИСЫВАЕМ тоже только разговорный ход (симметрично гарду на lookup выше): ответ на команду
  // в кэше — мина, даже если инструментов в том ходе не было (модель могла лишь ПЕРЕСПРОСИТЬ, и этот
  // переспрос с числами/состоянием оседал как «готовый ответ» на любую будущую такую команду).
  if (deps.responseCache && st.progress.toolTrajectory.length === 0 && opts?.conversational === true && !opts?.selectionAtStart && !deps.selection?.get()) {
    void deps.responseCache.store(deps.userId, text, spokenFinal);
  }
  return terminal(spokenFinal);
}

/** Порядок строк — ПОРЯДОК прежней if-цепочки: первый истинный предикат решает. Не переставлять без ревью честности. */
const TERMINALS: ReadonlyArray<[(ctx: LoopCtx, o: LoopOutcome) => boolean, (ctx: LoopCtx, o: LoopOutcome, env: TerminalEnv) => AgentReply]> = [
  [(ctx) => ctx.st.exit.cancelled, terminalCancelled],
  [(ctx) => ctx.st.exit.queueTimedOut, terminalQueueTimedOut],
  [(ctx) => ctx.st.exit.failed, terminalFailed],
  [(ctx) => ctx.st.exit.limited, terminalLimited],
  [(ctx) => ctx.st.exit.channelLost, terminalChannelLost],
  [(_ctx, o) => o.capExhausted, terminalCapExhausted],
  [(ctx) => ctx.st.exit.timedOut, terminalTimedOut],
  [(ctx) => ctx.st.exit.llmStubbed, terminalLlmStubbed],
  [(ctx) => ctx.st.exit.runawayStuck, terminalRunawayStuck],
  [(_ctx, o) => o.maskedFailure, terminalMaskedFailure],
  [(ctx) => ctx.st.exit.floodStuck, terminalFloodStuck],
];

export function selectTerminal(ctx: LoopCtx, o: LoopOutcome): AgentReply {
  const { st } = ctx;
  const terminal = makeTerminal(ctx);
  // Волна E: `saveCheckpoint` объявлен ВЫШЕ петли (нужен и страховочному снимку на 70%-нудже,
  // не только терминалам) — см. определение рядом с pushSystemNote.

  const doneRounds = Math.max(st.progress.round, st.progress.committedToolRounds);
  refreshResumeJournal(ctx);
  const env: TerminalEnv = { terminal, doneRounds };
  for (const [when, run] of TERMINALS) if (when(ctx, o)) return run(ctx, o, env);
  return terminalSuccess(ctx, o, env);
}
