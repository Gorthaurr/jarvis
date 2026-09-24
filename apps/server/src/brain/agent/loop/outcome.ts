// W3 «Петля»: чистый исход задачи из состояния петли (computeOutcome) — по нему гейтятся самообучение, метрики и терминал.
import type { LoopCtx } from "./context.js";
import { isHollowSuccess } from "../error-voice.js";

export function computeOutcome(ctx: LoopCtx) {
  const { opts, st } = ctx;
  const { HARD_STEP_CAP } = ctx.cfg;
  // Ревью волны Б (#4): петля исчерпала HARD_STEP_CAP БЕЗ финального текста (модель звала инструменты
  // до упора и не ответила словами) — это НЕ успех. Раньше падало в дефолтный «Готово.» (ложный успех
  // на вопрос — нарушение закона честности). Особенно достижимо после Б6 (кап разговора 3): 3 tool-
  // раунда подряд без ответа → сюда. 2-й проход ревью (#3): считаем по loopIters (фактические итерации),
  // а НЕ round — тот отстаёт из-за continue (channel-down/нудж), и capExhausted мог не сработать при
  // истинном исчерпании → ложное «Готово». loopIters>=cap && пусто && не вышли по другой причине.
  const capExhausted =
    st.progress.loopIters >= HARD_STEP_CAP && !st.progress.finalText && !st.exit.cancelled && !st.exit.timedOut && !st.exit.queueTimedOut && !st.exit.channelLost;
  // 5-й проход ревью (#2): capExhausted, но на РАЗГОВОРНОМ ходе есть сохранённый ответ (нудж обнулил
  // finalText, кап не дал переспросить) → терминал ниже его ОЗВУЧИТ как успех. Значит и метрики/статус
  // задачи обязаны быть УСПЕХОМ (иначе ok=false в metrics при реально отданном ответе — рассинхрон).
  const capAnswered = capExhausted && Boolean(st.progress.lastAnswer) && opts?.conversational === true && !st.honesty.blindMutatePending;

  // §8 HERMES самообучение: задача решена САМА (успешно), готового навыка не было (recalled===null)
  // и сам не сохранил по ходу → один бэкстоп-ход предлагает сохранить приём навыком. Узкий набор
  // (только skill_save/skill_list) — рефлексия не делает реальных действий. Триггер: многошагово
  // (round≥3) ИЛИ Джарвис сам НАШЁЛ способ в вебе (wasResearched, даже за 1-2 шага — иначе будет
  // гуглить то же заново; ровно жалоба владельца «должен искать и запоминать»).
  // maskedFailure/taskOk считаются ЗДЕСЬ (а не ниже, у телеметрии): по ним гейтится самообучение —
  // сохранять «приём» из траектории, которая НЕ привела к результату, нельзя (контроль-5). Обе величины
  // — чистые производные уже финальных переменных петли, порядок вычисления от переноса не меняется.
  // Контроль-6 (SR-C6-2): действие ушло под вуалью и модель СВЕРИЛА исход чистым взглядом — её «ушло» опирается
  // на наблюдение, а не на «ok» инструмента; masked-failure тут дал бы ложное «Не вышло».
  // Контроль-8 (verified-after-veil-rearm): сверка удостоверяет ТОЛЬКО ушедшее действие; непокрытый отказ вуали
  // (мутация, которая не состоялась) её обесценивает — иначе фикс контроля-7 снимался первым же чистым сенсором.
  // Контроль-10: «ушедшее действие сверено чистым взглядом» — САМОСТОЯТЕЛЬНЫЙ факт, и терминал обязан его назвать,
  // даже когда ход всё равно провален непокрытым отказом вуали (иначе владельцу говорят «не сделал» про отправленное).
  const injectedVerified = st.honesty.overlayActionInjected && st.honesty.verifiedAfterVeil;
  const veilOutcomeVerified = injectedVerified && !st.honesty.veilDeniedNothingDone;
  // Контроль-7 (loop-3): полое «Сделано» при k исполненных шагах / ушедшем действии — провал, но ЧЕСТНЫЙ overlay-терминал
  // (называет k и «ушло»), а не «инструменты не отработали» — по нему владелец повторял команду и получал дубль.
  const overlayPartialOutcome = st.honesty.overlayDeniedAny && !st.honesty.anyMutateSucceeded && (st.honesty.overlayPartialTotal > 0 || st.honesty.overlayActionInjected);
  // Контроль-8 (durable-neutral-masked): durable-дело нейтральным инструментом (напоминание/память/наблюдение) —
  // это СДЕЛАННОЕ дело. Признак вводился контролем-6 с этой формулировкой, но был подключён к ОДНОМУ потребителю
  // (give-up), и «поставь напоминание» + дворецкое «Готово, сэр.» давало «Не вышло — нужное действие не сработало»
  // при реально созданном напоминании. Гасим узко: только когда мутирующего дела в ходе не пробовали вовсе.
  const durableNeutralDone = st.honesty.anyDurableNeutralSucceeded && !st.honesty.anyMutateAttempted;
  const maskedFailure =
    opts?.conversational !== true &&
    st.progress.toolTrajectory.length > 0 &&
    !st.honesty.anyMutateSucceeded &&
    !veilOutcomeVerified &&
    !overlayPartialOutcome &&
    !durableNeutralDone &&
    isHollowSuccess(st.progress.finalText || "");

  // «Ввод не дали и при этом НИЧЕГО не сделано» — не успех. Узко и структурно: ход, который отказ
  // пережил и добился своего другим путём (anyMutateSucceeded), успехом остаётся; исключения для
  // разговорного хода тут НЕТ — телеметрия обязана быть честной и там.
  const inputDeniedFailure = st.honesty.inputDenied && !st.honesty.anyMutateSucceeded;
  // Контроль-3: «вуаль не дала и ничего не сделано» — тот же класс, второй признак (иначе state:done, ok:true,
  // навыку — успех, «доделай» гасит журнал при нуле выполненных действий).
  // Контроль-5 (V4-1): + честный give-up после раунда, остановленного вуалью, без единого дела.
  const overlayDeniedFailure = (st.honesty.overlayDeniedAny || st.honesty.veilGaveUp) && !st.honesty.anyMutateSucceeded && !veilOutcomeVerified;
  // Ревью 2026-09-24 (T-F7): действие ПРОБОВАЛИ (mutate), ни одна попытка не удалась, durable-дела нейтральным
  // инструментом тоже нет — это провал, даже когда модель ЧЕСТНО сказала «не выполнено» (содержательная фраза
  // мимо masked-failure: тот ловит только полое «Готово»). Раньше такой ход писался ok:true / done — и в метриках,
  // и в самодиагностике он выглядел успехом. Разговорный ход «дела» не обещал — его не трогаем. Реплику модели
  // терминал НЕ подменяет (она честная) — меняется только запись об исходе.
  // «Исход неизвестен» (фоновое задание запущено, отправка без подтверждения) и частично исполненная процедура —
  // не «ни одна не удалась»: там что-то УШЛО, и объявлять ход провалом значило бы звать «доделай» на дубль.
  const mutationsAllFailed =
    opts?.conversational !== true &&
    st.honesty.anyMutateAttempted &&
    !st.honesty.anyMutateSucceeded &&
    !st.honesty.anyDurableNeutralSucceeded &&
    st.honesty.uncertainCalls.size === 0 &&
    st.honesty.partialCalls.size === 0 &&
    !veilOutcomeVerified &&
    !overlayPartialOutcome;
  const okBeforeMutations =
    !st.exit.failed && !st.exit.limited && !st.exit.timedOut && !st.exit.cancelled && !maskedFailure && !st.exit.llmStubbed && !st.exit.runawayStuck && !st.exit.floodStuck && !st.exit.queueTimedOut && !st.exit.channelLost && !inputDeniedFailure && !overlayDeniedFailure && (!capExhausted || capAnswered);
  const taskOk = okBeforeMutations && !mutationsAllFailed;
  // Провал ТОЛЬКО по T-F7 (иначе ход дошёл бы до успешного терминала): реестр задач переводит его в failed сам —
  // терминалы провала выше по таблице ставят failed своими причинами.
  const allMutationsFailed = okBeforeMutations && mutationsAllFailed;
  return { capExhausted, capAnswered, injectedVerified, veilOutcomeVerified, overlayPartialOutcome, durableNeutralDone, maskedFailure, inputDeniedFailure, overlayDeniedFailure, allMutationsFailed, taskOk };
}

export type LoopOutcome = ReturnType<typeof computeOutcome>;
