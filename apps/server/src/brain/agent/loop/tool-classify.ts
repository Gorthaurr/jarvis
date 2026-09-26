// W3 «Петля»: классификация результата ОДНОГО вызова инструмента: учёт, эффекты успеха, признаки раунда.
import { log, isSendKey, isPasteCombo, inspectBatchSteps, actGesture } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { RoundResult } from "./tool-round.js";
import type { ToolResult } from "../../tools/dispatch.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { describeIrreversible } from "../../tasks/misfire.js";
import { OUTBOUND_SEND_TOOLS, DURABLE_NEUTRAL_TOOLS, LAUNCH_ONLY_TOOLS, isBlindMutate, toolCallEffect } from "../error-voice.js";
import { inspectWebBatch, webActGesture } from "./browser-gesture.js";
import { actionTitle, stepLabelFor } from "../../tasks/task.js";

export function noteToolCall(ctx: LoopCtx, tu: LlmResponse["toolUses"][number], r: ToolResult, round: RoundResult) {
  const { deps, st, task } = ctx;
  const { MACRO_TRACE_TOOLS } = ctx.cfg;
  log.info("tool", { name: tu.name, isError: r.isError });
  // §20 чип «что делаю сейчас» (жалоба «не видно, что делает»): метка текущего действия обновляется на
  // КАЖДОМ инструменте; emitTaskStatus в конце раунда отдаст последнюю на клиент. Не для conversational.
  if (!task.conversational) task.stepLabel = stepLabelFor(tu.name, tu.input as Record<string, unknown>);
  // §20 чип «по смыслу»: на первом значимом действии переименовываем задачу из сырой фразы
  // в суть («Яндекс Музыка», «Запуск OBS»). emitTaskStatus в конце раунда обновит чип.
  if (!st.progress.semanticTitleSet) {
    const at = actionTitle(tu.name, tu.input as Record<string, unknown>);
    if (at) {
      task.title = at;
      st.progress.semanticTitleSet = true;
    }
  }
  // §8: копим траекторию для самообучения; отмечаем успех и уже-сохранённый навык.
  st.progress.toolTrajectory.push(`${tu.name}${r.isError ? " (ошибка)" : ""}`);
  if (!r.isError) st.honesty.anyToolSucceeded = true;
  // Ревью #5: блокирующее ОЖИДАНИЕ вызова (wait_for browser) вычитаем из бюджета задачи (как queue).
  // Сдвигаем loopStartMs СРАЗУ (не в конце раунда) — иначе continue (channelDown) / break пропустили бы
  // сдвиг и idle засчитался бы в потолок (десинк, ревью-2 #5-кромка). Двойного учёта нет: roundDurTotalMs
  // ниже вычитает roundIdleMs, но loopStartMs там уже НЕ трогаем.
  if (typeof r.idleWaitMs === "number" && r.idleWaitMs > 0) {
    st.budget.idleWaitMs += r.idleWaitMs;
    st.budget.loopStartMs += r.idleWaitMs;
  }
  // §8 МАКРОС: жесты (фокус/клик/клавиши) с данными актуатора (разрешённые координаты клика) —
  // сырьё для компиляции авто-реплея после успеха задачи.
  if (!r.isError && MACRO_TRACE_TOOLS.has(tu.name)) {
    st.progress.gestureTrace.push({ name: tu.name, input: tu.input, data: r.data });
  }
  // VERIFY-петля: классифицируем эффект успешного инструмента. Сверка глазами (read/inspect/capture)
  // → verifiedSinceMutate=true. Меняющее действие → didMutate=true и сбрасываем verifiedSinceMutate
  // (значит после него ещё НЕ смотрели). Нейтральные (поиск/память/навыки/load) не трогают флаги.
  // §Волна2 (2.1) fused act+observe: r.observed — актуатор приложил РЕАЛЬНОЕ наблюдение состояния
  // в ЭТОТ ЖЕ tool_result (a11y/OCR после действия, DOM-диф браузера, met:true у wait_for) →
  // сверка состоялась в том же раунде: verify-долг не взводится/снимается БЕЗ отдельного раунда.
  // Строгость verify-LAW не ослаблена — наблюдение реальное, а не доверие к «ok» действия.
  // 🔴 «ИСХОД НЕИЗВЕСТЕН» ставится ДО разветвления по isError (аудит тестовой базы 2026-09-01).
  // Прежде эта строка стояла ВНУТРИ ветки успеха — то есть была мёртвым кодом: неопределённый
  // исход отправки возвращается как ОШИБКА (`err(...)`, isError:true), и метка не ставилась
  // никогда. Журнал прерванной задачи писал «ОШИБКА» = «не сделано», и продолжение по «доделай»
  // повторило бы отправку живому человеку. Тот же класс, что мёртвый `gateStoppedRound` из
  // контроля-3 пульта Ф0: фикс есть, а проводки нет.
  if (r.uncertain === true) st.honesty.uncertainCalls.add(tu.id);
  // Контроль-9 (any-mutate-attempted-ignores-declared-effect): эффект — РАЗРЕШЁННЫЙ (декларация mcp.json главнее
  // эвристики по имени, op-override у screen_selection), один на весь разбор вызова. Раньше здесь стоял голый
  // `toolEffect`, и `mcp__think__sequentialthinking` (объявлен neutral, но имя не проходит READONLY_NAME_RE)
  // считался попыткой мутации: `durableNeutralDone` гас, и реально созданное напоминание объявлялось «не сработало».
  // W1: эффект по ВХОДУ (toolCallEffect) — screen_selection по op, browser_act{hover|scroll_to} нейтральны,
  // browser_tabs{op:"close"} — дело. Та же функция у журнала чекпойнта (checkpoint-save.ts effectOf).
  const effOfCall = (tu.name.startsWith("mcp__") ? deps.mcp?.declaredEffect(tu.name) : undefined) ?? toolCallEffect(tu.name, tu.input);
  if (effOfCall === "mutate") st.honesty.anyMutateAttempted = true; // контроль-8 (durable-neutral-masked)
  // Контроль-8 (background-job-no-success/-string-flag): жизнь ФОНОВОГО задания. Запуск неопределён (spawn ≠ исход),
  // завершение с кодом 0 — РЕАЛЬНО сделанная мутирующая работа (иначе «инструменты не отработали» при собранном
  // проекте), а «ещё выполняется» — не капитуляция модели (иначе честное «пока не могу сказать» получало нудж
  // «СТОП, не сдавайся» и эскалацию на Opus за ожидание фонового процесса).
  // Контроль-10 (job-report-self-registers-launch): «запуск» регистрирует ТОЛЬКО реальный запуск. Раньше условием
  // был `uncertain`, а его ставит и `overlayDeniedResult` у ОТЧЁТА об остановке — отчёт регистрировал сам себя,
  // и гейт «отчёт этого хода» становился мёртвым ровно для инжектированных остановок.
  if (typeof r.jobId === "string" && r.jobLaunched === true) st.honesty.jobLaunchCalls.set(r.jobId, tu.id);
  // Идемпотентный отчёт о задании, запущенном НЕ в этом ходе, не может решать исход текущего хода: реестр заданий
  // клиента отвечает одинаково 6 часов (контроль-9 ввёл этот гейт для вуальной ветки, контроль-10 — для остальных).
  const reportOfThisTurn = typeof r.jobId !== "string" || st.honesty.jobLaunchCalls.has(r.jobId);
  if (r.backgroundJob === "done" && reportOfThisTurn) {
    st.honesty.anyMutateSucceeded = true;
    const launch = typeof r.jobId === "string" ? st.honesty.jobLaunchCalls.get(r.jobId) : undefined;
    if (launch) st.honesty.uncertainCalls.delete(launch); // исход выяснен — журнал не зовёт его неизвестным
  } else if (r.backgroundJob === "running") {
    // Контроль-9 (background-running-gate-whole-round): признак РАУНДОВЫЙ, как у вуали. Раньше он ставился прямо
    // здесь, и один идущий job_status рядом с двумя провалившимися инструментами глушил анти-капитуляцию и
    // goal-check на весь следующий раунд — настоящая капитуляция проходила молча под прикрытием фонового процесса.
    round.backgroundRunningIds.add(tu.id);
  } else if (r.backgroundJob === "killed") {
    // Контроль-9 (job-kill-neutral-masked-failure): «останови сборку» → job_status{kill} РЕАЛЬНО бьёт дерево
    // процессов, но инструмент нейтрален и в DURABLE_NEUTRAL_TOOLS не входит — дворецкое «Готово, сэр.»
    // подменялось на «Не вышло, сэр — нужное действие не сработало» при убитой сборке.
    st.honesty.anyDurableNeutralSucceeded = true;
  }
  // Контроль-8 (step-failure-journal): ЧАСТИЧНОЕ исполнение процедуры доходит до журнала НЕЗАВИСИМО от причины
  // остановки. Раньше `partialCalls` наполнялся только внутри ветки вуали, и обычный провал берста на шаге 3
  // («элемент не найден») уезжал в несокращаемую секцию как «ОШИБКА» — «доделай» повторяло набор и клики.
  if ((typeof r.partialSteps === "number" && r.partialSteps > 0) || r.partialInjected === true) {
    st.honesty.partialCalls.set(tu.id, { k: r.partialSteps ?? 0, injected: r.partialInjected === true });
  }
  return { effOfCall, reportOfThisTurn };
}

export function applySuccessEffects(ctx: LoopCtx, tu: LlmResponse["toolUses"][number], r: ToolResult, effOfCall: "verify" | "mutate" | "neutral", round: RoundResult): void {
  const { deps, st, taskId, buildToolSet } = ctx;
  const { STRUCTURAL_SENSORS } = ctx.cfg;
  // §15: подгрузили холодный инструмент — он обязан появиться в наборе СЛЕДУЮЩЕГО шага ЭТОЙ же
  // задачи, иначе модель зовёт tool_load по кругу (живой эпизод 2026-09-01: три вызова подряд и
  // честное «инструмент так и не поднялся»). На основном канале дефект маскировал фолбэк
  // dispatch — он исполняет по имени и без схемы; в резерве на подписке набор инструментов
  // единственный источник доступного, поэтому там подгрузка не работала совсем.
  // ⚠️ Стоит в ОБЩЕМ пути результата: tool_load нейтрален (в mutate-ветке он не бывает).
  if (tu.name === "tool_load") ({ tools: st.arsenal.tools, systemTools: st.arsenal.systemTools } = buildToolSet());
  // MCP-контракт (аудит 2026-07-28): декларация владельца в mcp.json главнее эвристики по имени —
  // «think»≠mutate (не слепит masked-failure), мутирующий get_* не проскочит neutral'ом.
  // §режим выделения: у screen_selection ТРИ операции под одним именем — по имени он neutral, но
  // `view` — настоящий свежий кадр области (как screen_capture) и verify-долг снимает; start/clear — нет.
  const eff = effOfCall; // контроль-9: один разрешённый эффект на весь разбор вызова (вычислен выше)
  // 🔴 ЛЕСТНИЦА ВОСПРИЯТИЯ (форензика 2026-09-01). Числа: screen_capture — 156 вызовов (самый
  // частый инструмент вообще), ui_snapshot — 0 из 973 за два месяца; задачи со скринами дают
  // 76% успеха против 88% у остальных. Лестница была прописана только словами в персоне и в
  // verify-нуджах, а механики у неё не было — модель шла за картинкой, потому что картинка
  // универсальна. Отмечаем факты, чтобы один раз за задачу дать конкретную подсказку.
  if (STRUCTURAL_SENSORS.has(tu.name)) st.nudge.sawStructuralLook = true;
  if (tu.name === "browser_open" || tu.name === "browser_act" || tu.name === "browser_read") st.nudge.browserish = true;
  // Первый в задаче screen_capture ДО единого структурного взгляда (и не в браузерной задаче) →
  // ОДНА подсказка. Не запрет: на UIA-слепом окне (игра/canvas) картинка — единственный путь, и
  // ui_snapshot честно вернёт пустоту с пометкой. Цена ошибки подсказки — один дешёвый вызов;
  // цена молчания — «смотрю на компьютер как на картинку», что и показала форензика.
  // ⚠️ ВРЕЗКУ ЗДЕСЬ ДЕЛАТЬ НЕЛЬЗЯ (адверс-ревью 2026-09-01, HIGH): мы внутри цикла по tool_use,
  // и appendUserNote вставил бы user-сообщение МЕЖДУ assistant(tool_use) и tool_result —
  // Anthropic отвечает 400 на первом же скриншоте. Копим флаг, впрыск после resultBlocks.
  if (tu.name === "screen_capture" && !st.nudge.sawStructuralLook && !st.nudge.browserish && !st.nudge.ladderHinted) {
    st.nudge.ladderHinted = true;
    st.nudge.ladderHintPending = true;
  }
  const observed = r.observed === true;
  // ЯВНЫЙ взгляд (screen_capture/ui_snapshot/browser_read/…). 🔴 Ревью 2026-09-01: одного
  // ФАКТА вызова мало — сенсор мог отработать без ошибки и не увидеть ничего (UIA-слепое окно
  // отдаёт items:[], OCR — пустой текст). Такой «взгляд» гасил и обычный verify-долг, и долг
  // сверки отправки, притом что соседний fused-путь то же самое пустое наблюдение считает
  // слабым. Пустой и ошибочный результат сверкой не считаем.
  const realVerify = eff === "verify" && !r.isError && r.empty !== true;
  // Контроль-6 (SR-C6-2): действие ушло под вуалью, потом модель СВЕРИЛА исход ЧИСТЫМ взглядом (не под вуалью) —
  // «остальное — нет / исход не подтверждён» и failed в реестре были бы ложью; дальше судит её текст.
  if (st.honesty.overlayActionInjected && realVerify && r.veiled !== true) st.honesty.verifiedAfterVeil = true;
  // Контроль-6 (C5R-5): durable-дело нейтральным инструментом — не «ничего не сделано».
  if (eff === "neutral" && DURABLE_NEUTRAL_TOOLS.has(tu.name)) st.honesty.anyDurableNeutralSucceeded = true;
  const combo = (tu.input as { combo?: unknown }).combo;
  // §P1-отправка (форензика «Отправлено — ушло в Клод», а сообщение осталось в поле): КОММИТ =
  // send-key после набора (composedPending), ЛИБО берст compose→send одним input_batch (ревью р1
  // #3/#9). Fused-наблюдение коммита — снимок «факт нажатия», НЕ исход → долг сверки исхода.
  // W1 «браузерные руки»: берст во вкладке (`{ref,intent,params}`) — тот же закон «поле → кнопка = отправка».
  const batch =
    tu.name === "input_batch" ? inspectBatchSteps(tu.input) : tu.name === "browser_batch" ? inspectWebBatch(tu.input) : { committed: false, endsComposed: false, hasSend: false };
  // КОММИТ отправки после набора (composedPending): не только Enter — ревью р2 #3: чаще жмут КНОПКУ
  // «Отправить» (input_click/input_mouse/ui_invoke). Любой такой жест после набора = коммит → долг
  // сверки исхода (как compose-and-commit в replayUnsafe). Ложный позитив (клик мимо кнопки) стоит
  // одной лишней сверки — дёшево против ложного «Отправлено». Ревью р3 #1/#4: input_batch с
  // коммит-шагом (batch.hasSend) при наборе В ПРОШЛОМ раунде (composedPending) — тоже коммит.
  // W4 «Руки»: act click/double/key-Enter после набора — тот же коммит (его сверка признаком долг отправки НЕ снимает).
  // W1: browser_act — то же для вкладки: type/set → key Enter/click/submit; type/set с enter:true — набор И коммит
  // одним вызовом (readback поля такой коммит НЕ сверяет — исход отправки только реальным взглядом).
  const actG = tu.name === "act" ? actGesture(tu.input) : tu.name === "browser_act" ? webActGesture(tu.input) : { commit: false, composes: false };
  const commitGesture =
    (tu.name === "input_key" && isSendKey(combo)) ||
    tu.name === "input_click" ||
    tu.name === "input_mouse" ||
    tu.name === "ui_invoke" ||
    actG.commit;
  const sendCommit = ((commitGesture || batch.hasSend) && st.honesty.composedPending) || batch.committed || (actG.commit && actG.composes);
  // СНЯТИЕ долга: реальный взгляд снимает ВСЁ (вкл. sendCommitDebt). Fused-наблюдение снимает только
  // ОБЫЧНЫЙ слепой долг и только если это НЕ коммит и НЕ висит долг отправки (ревью р1 #4/#8/#16:
  // соседний Enter/клик/фокус не должен гасить долг отправки своим слабым снимком).
  if (realVerify) {
    st.honesty.blindMutatePending = false;
    st.honesty.sendCommitDebt = false;
    round.sawVerifyThisRound = true;
    st.budget.lastAcquireWaitMs = 0;
  } else if (observed && !sendCommit && !st.honesty.sendCommitDebt) {
    st.honesty.blindMutatePending = false;
    round.sawVerifyThisRound = true;
    st.budget.lastAcquireWaitMs = 0;
  }
  if (eff === "mutate") {
    // P0.1: реальное дело сделано (не просто нейтральный поиск). Для ИСХОДЯЩИХ сендов человеку —
    // строго r.sent (ревью 2026-07-24): честные отказы хендлера («не подтвердили», «повтор не
    // ушёл») — тоже isError:false, но НЕ отправка; взводить по ним anyMutateSucceeded = отключать
    // masked-failure/анти-капитуляцию без реального дела (ложное «Готово, отправил» не поймалось бы).
    // Ф0 пульта (адверс-ревью, HIGH): `declined` — действие НЕ выполнено, потому что §14-гейт
    // его не пропустил (отказ / не ответил / не смогли спросить). Раньше такой результат
    // (isError:false) взводил флаг для fs_delete/system_power/code_run/skill_execute/MCP →
    // masked-failure и анти-капитуляция глохли, и ход заканчивался «Готово» при нулевом деле.
    // Контроль-7 (sdk-2/sdk-3): «исход неизвестен» (скрипт перехватил отказ вуали и продолжил; фоновое задание
    // только ЗАПУЩЕНО — spawn ≠ исход) — не «дело сделано»: иначе masked-failure и анти-капитуляция глохнут.
    // Контроль-8 (background-string-flag): признак берём из НОРМАЛИЗОВАННОГО `uncertain` хендлера, а не из сырого
    // input — форма `background:"true"` (её хендлер принимает) мимо прежней проверки взводила «дело сделано».
    if (r.declined !== true && r.uncertain !== true && (!OUTBOUND_SEND_TOOLS.has(tu.name) || r.sent === true)) st.honesty.anyMutateSucceeded = true;
    if (r.declined === true) {
      st.honesty.declinedCalls.add(tu.id); // журнал не должен звать это «сделанным»
      // Контроль-2 Ф0: остановка §14-ГЕЙТОМ — это НЕ капитуляция модели. Без этого флага мой же
      // фикс (declined не взводит anyMutateSucceeded) включал анти-капитуляцию: нудж «не
      // сдавайся» + эскалация на Opus + ПОВТОРНЫЙ вопрос владельцу о том, на что он только что
      // ответил «нет» (или на что не смог ответить — канал мёртв, и Opus жгли «от транспорта»).
      st.honesty.gateStoppedRound = true;
    }
    // Волна C: журнал чекпойнта должен знать ТО ЖЕ САМОЕ — «нет ошибки» у отправки человеку ещё
    // не значит «ушло» (не подтвердили / повтор не ушёл). Иначе секция «СДЕЛАНО» соврёт.
    if (OUTBOUND_SEND_TOOLS.has(tu.name) && r.sent === true) {
      st.honesty.confirmedSends.add(tu.id);
      // Волна H (ложный запуск): задача обязана ПОМНИТЬ совершённое необратимое. Если владелец
      // скажет «это была не команда», отмена остановит работу — но отправленное уже не вернуть,
      // и об этом нужно сказать прямо, а не рапортовать «остановил», будто ничего не случилось.
      deps.tasks?.noteIrreversible(taskId, describeIrreversible(tu.name, tu.input));
    }
    if (sendCommit) {
      st.honesty.blindMutatePending = true;
      st.honesty.sendCommitDebt = true; // исход отправки сверяется ТОЛЬКО реальным взглядом
      st.honesty.composedPending = false;
    } else if (isBlindMutate(tu.name) && !observed) {
      st.honesty.blindMutatePending = true;
    }
    // Взвод «набрал текст» — любым путём (type/setValue/вставка/берст, оканчивающийся набором).
    if (
      tu.name === "input_type" ||
      (tu.name === "ui_invoke" && (tu.input as { pattern?: unknown }).pattern === "setValue") ||
      (tu.name === "input_key" && isPasteCombo(combo)) ||
      (actG.composes && !actG.commit) ||
      batch.endsComposed
    ) {
      st.honesty.composedPending = true;
    }
  }
  noteRealAction(ctx, tu, r, eff, realVerify, observed && !sendCommit);
}

/**
 * W1 (L-3): СВЕРЕНО ли в задаче дело, а не только запуск. Не-запускной mutate с приложенным наблюдением (act
 * verified:"met", readback поля) — сверен сразу; без наблюдения — ждёт реального взгляда. Коммит отправки своим
 * снимком себя не сверяет (снимок = факт нажатия). Потребитель — goal-check (loop/nudge-policy.ts).
 */
function noteRealAction(ctx: LoopCtx, tu: LlmResponse["toolUses"][number], r: ToolResult, eff: "verify" | "mutate" | "neutral", realVerify: boolean, selfObserved: boolean): void {
  const h = ctx.st.honesty;
  if (realVerify && h.realActionUnverified) {
    h.verifiedRealAction = true;
    h.realActionUnverified = false;
  }
  // Только РУКИ (слепые mutate: act/browser_act/input_*…): самоподтверждающийся mutate (громкость, код, файл) себя уже
  // подтвердил, и взгляд после него не делает «Запустил Доту» сверенным делом (app_launch → system_volume → скрин).
  if (eff !== "mutate" || !isBlindMutate(tu.name) || LAUNCH_ONLY_TOOLS.has(tu.name) || r.declined === true || r.uncertain === true) return;
  if (selfObserved) h.verifiedRealAction = true;
  else h.realActionUnverified = true;
}

export function applyRoundFlags(ctx: LoopCtx, tu: LlmResponse["toolUses"][number], r: ToolResult, effOfCall: "verify" | "mutate" | "neutral", reportOfThisTurn: boolean, round: RoundResult): void {
  const { st, notePartial } = ctx;
  if (tu.name === "skill_save" && !r.isError) {
    st.progress.skillSavedInLoop = true;
    st.progress.savedSkillId = (r.data as { id?: string } | undefined)?.id ?? st.progress.savedSkillId; // §8 МАКРОС
  }
  if ((tu.name === "web_search" || tu.name === "web_fetch") && !r.isError) st.progress.wasResearched = true;
  if (r.channelDown) round.roundChannelDown = true; // Б4: команда не ушла — канал мёртв (не провал модели)
  if (r.isError) round.roundErrors += 1;
  if (r.veiled && effOfCall !== "mutate") {
    // Контроль-6 (C5R-3): «ожидание под вуалью» — только сенсор/кадр/опрос. МУТАЦИЯ с наблюдением из окна
    // оверлея (ui_invoke по одному хендлу ×6) остаётся под identical-repeat и семейным капом — иначе без
    // единого гарда и с state:done.
    round.roundVeiled = true;
    round.veiledIds.add(tu.id);
  }
  if (r.overlayDenied) {
    round.overlayDeniedIds.add(tu.id);
    // Контроль-5: сколько шагов УЖЕ исполнено до остановки и ушло ли действие — терминал и журнал обязаны это назвать.
    if (typeof r.overlayStepIndex === "number" && reportOfThisTurn) {
      // Контроль-10 (partial-steps-zero-overwrite): НУЛЕВАЯ остановка (раннер срезал ПЕРВЫЙ шаг) — не «последняя
      // остановка на 0 шагах»: она перетирала честное k и давала «остановлено после 0 выполненных шагов (всего 3)».
      if (r.overlayStepIndex > 0) st.honesty.overlayPartialSteps = r.overlayStepIndex;
      // Контроль-8 (job-status-double-count): по ИСТОЧНИКУ, а не накоплением: идемпотентный отчёт job_status об
      // ОДНОМ задании не складывается сам с собой (два берста по 2 и 1 по-прежнему дают «всего 3»).
      notePartial(typeof r.jobId === "string" ? `job:${r.jobId}` : `call:${tu.id}`, r.overlayStepIndex);
    }
    if (r.overlayActionInjected === true) st.honesty.overlayActionInjected = true;
    // Контроль-4: «вуаль не дала и ничего не сделано» — только про МУТИРУЮЩИЙ вызов (input_*/input_batch/
    // skill_execute): отказанный ВЗГЛЯД (screen_selection view = verify) не делает верно отвеченный
    // ход провальным (раньше: «Тут написано X» + «Нужное действие я не сделал: вуаль» + failed).
    // Контроль-8 (job-status-not-mutate): но класс судится по СМЫСЛУ ИСХОДА, а не по ВИДУ вызова — остановленная
    // вуалью ПРОЦЕДУРА (есть исполненные шаги / ушедшее действие) мутирующая, даже если о ней доложил НЕЙТРАЛЬНЫЙ
    // `job_status` фонового скрипта: иначе на финале «Готово» терминал говорил «инструменты не отработали» про два
    // уже ушедших клика, а на содержательном финале ход вообще уходил в done. Это ровно корень контроля-6,
    // вернувшийся через мой же фикс контроля-7 (sdk-2).
    // Контроль-9 (job-veil-done0-not-failure): «процедура остановлена» — структурный признак ОТЧЁТА, а не наличие
    // исполненных шагов: фоновый скрипт, легший об вуаль на ПЕРВОМ действии (done=0, ничего не инжектировано),
    // не давал ни stepIndex, ни injected — и ход, в котором не сделано НИЧЕГО, уходил в done с ok:true.
    // Контроль-9 (job-status-past-stop-fails-turn): но НЕЙТРАЛЬНЫЙ отчёт о ПРОШЛОЙ остановке (реестр заданий
    // живёт 6 часов и отвечает идемпотентно) провалом ЭТОГО хода быть не может — иначе на вопрос «что там со
    // скриптом?» верный ответ помечался failed. Считаем только отчёт о задании, запущенном ЗДЕСЬ.
    const procedureStopped =
      typeof r.overlayStepIndex === "number" || r.overlayActionInjected === true || r.overlayProcedure === true;
    if (tu.name !== "screen_selection" && (effOfCall === "mutate" || (procedureStopped && reportOfThisTurn))) {
      st.honesty.overlayDeniedAny = true;
      // Контроль-7 (loop-2): «сверено чистым взглядом» относится к ПРЕЖНЕМУ ушедшему действию; новый отказ вуалью
      // (ничего не сделано) не может ехать под старой сверкой в done.
      st.honesty.verifiedAfterVeil = false;
      // Контроль-8 (verified-after-veil-rearm): отказ, при котором НИЧЕГО не ушло, чистым взглядом не «удостоверяется»
      // — сверять нечего. Иначе следующий же ui_snapshot снимал признак обратно и «Готово» ехало в done.
      if (r.overlayActionInjected !== true) st.honesty.veilDeniedNothingDone = true;
    }
  }
}
