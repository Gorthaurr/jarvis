// W3 «Петля»: NudgePolicy — четыре нуджа текстового хода (анти-капитуляция, verify, goal-check, пустой финал) + докрутка max_tokens.
import { log } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { RoundSnapshot } from "./round-snapshot.js";
import type { LlmResponse } from "../../../integrations/llm.js";
import { claimsObservedResult, looksLikeGiveUp } from "../error-voice.js";

export function continueAfterMaxTokens(ctx: LoopCtx, step: number, resp: LlmResponse): boolean {
  const { sink, opts, st, convo, pushSystemNote } = ctx;
  const { MAX_CONTINUATIONS } = ctx.cfg;
  // Докрутка обрыва по лимиту вывода: модель упёрлась в max_tokens, не закончив. Продолжаем
  // ровно с места обрыва, а не отдаём огрызок. ТОЛЬКО для не-стримленного хода: голосовой
  // step0 уже произнесён в sink (повтор/двойной голос недопустим) — там берём как есть.
  // Ревью sync-first: под suppressStepStream step-0 НЕ стримился (ничего не произнесено) →
  // ход НЕ-стримленный → докрутку НАДО делать (иначе action-ответ обрезался бы огрызком, как
  // на фоновом пути её и делали). Без этого гарда флаг был ложно-истинным (sink есть, но нем).
  const streamedThisStep = Boolean(sink) && step === 0 && !opts?.suppressStepStream;
  if (resp.stopReason === "max_tokens" && !streamedThisStep && st.nudge.continuations < MAX_CONTINUATIONS) {
    st.nudge.continuations += 1;
    convo.push({ role: "assistant", content: resp.text });
    pushSystemNote("Продолжай ровно с места обрыва — без повторов, без преамбул и без финальных фраз, пока не закончишь.");
    log.info("докрутка вывода (max_tokens)", { continuations: st.nudge.continuations, of: MAX_CONTINUATIONS });
    return true;
  }
  return false;
}

export function antiCapitulation(ctx: LoopCtx, resp: LlmResponse, snap: RoundSnapshot): boolean {
  const { deps, tier, st, convo, pushSystemNote } = ctx;
  const { MAX_RETRY_NUDGES } = ctx.cfg;
  const { gateStoppedPrevRound, veilStoppedPrevRound } = snap;
  // Анти-капитуляция: модель закончила ход (end_turn) текстом-отказом, НЕ сделав НИ ОДНОГО вызова
  // инструмента за всю петлю → заставляем попробовать через инструменты, прежде чем принять отказ.
  // Кап=1 + общие потолки (шаги/токены/SpendGuard) исключают runaway. Только end_turn (обрыв по
  // max_tokens уже обработан выше). На голосовом пути озвучка идёт ПОСЛЕ петли (sink=undefined,
  // speakResult) → двойного голоса нет; на синхронном step0-стриме гард ниже не нужен (отказ обычно
  // не стримится тут). looksLikeGiveUp пропускает легитимную отбивку абсурда/опасного.
  // Анти-капитуляция: текст-отказ (looksLikeGiveUp), И при этом НЕ было НИ ОДНОГО успешного инструмента
  // (ноль вызовов ИЛИ все — провал/denied). Ревью: «сделал 1 промах (input_key→USER_BUSY) → сдался
  // словами» — массовый паттерн, раньше не ловился (гейт был traj===0). Теперь ловим и форсим попытку.
  // Контроль-5 (V4-1): прошлый раунд остановила ВУАЛЬ (взгляд/ожидание под ней), модель честно закрывает ход
  // «не могу — жду», и ни одного дела не сделано. Анти-капитуляция и goal-check его правильно не трогают,
  // но без этого признака ход заканчивался state:done, ok:true и УСПЕХОМ навыку при нуле сделанного.
  if (resp.stopReason === "end_turn" && veilStoppedPrevRound && looksLikeGiveUp(resp.text) && !st.honesty.anyMutateSucceeded && !st.honesty.anyDurableNeutralSucceeded) st.honesty.veilGaveUp = true;
  if (
    resp.stopReason === "end_turn" &&
    st.nudge.retryNudges < MAX_RETRY_NUDGES &&
    looksLikeGiveUp(resp.text) &&
    !gateStoppedPrevRound && // §14-гейт остановил действие в прошлом раунде — это не капитуляция модели
    !st.honesty.anyMutateSucceeded // P0.1: успешный НЕЙТРАЛЬНЫЙ инструмент (поиск/память) не считается «сделал» —
    // «погуглил → сдался словами» теперь форсит попытку. !anyMutateSucceeded включает и traj===0.
  ) {
    st.nudge.retryNudges += 1;
    // §Волна3 (3.2) + ревью Волны 3 (#3): капитуляция = ОСОЗНАННЫЙ форс-повтор → executor вниз НЕ
    // спускает. Флаг ставим БЕЗУСЛОВНО (до ветки эскалации): если §7 УЖЕ подняла на fable, а модель
    // сдалась текстом на fable, ветка ниже (currentTier!=="fable") не сработает — без этой строки
    // executor-даунгрейд вернул бы слабый тир ровно там, где повтор должен быть УМНЕЕ. Как в trading.
    // §rules ПРИМИРЕНИЕ нудж↔бюджет (аудит контекста 2026-07-20; уточнено ревью F9): под ВЗВЕДЁННЫМ
    // budget/context-нуджем («сворачивайся») агрессивное «СТОП, не сдавайся, keep trying forever»
    // ПРОТИВОРЕЧИТ «сворачивайся» в соседних раундах (док. боль). Примиряем ТОЛЬКО ТЕКСТ: когерентное
    // «ОДИН ход ИЛИ честный частичный итог» вместо «не сдавайся бесконечно». Opus-эскалацию НЕ подавляем
    // (ревью F9: на 70% ВРЕМЕНИ бюджет ещё есть — лишить выполнимую задачу сильного шота = слабый Sonnet
    // выдаст «не могу», а masked-failure его не ловит → ложный отказ как честный исход). Один сильный
    // повтор ограничен retryNudges-капом, а «лишние Opus поверх лимита» гасят кап + HARD контекст-гард.
    // Verify/goal-check НЕ трогаем — честностные сверки исхода (подавление = ложный успех).
    const underWrapPressure = st.budget.budgetNudged || st.budget.contextNudged;
    st.tier.strongLocked = true;
    // На отказе СРАЗУ эскалируем на сильную модель (Opus) — повтор должен быть УМНЕЕ, а не на той же
    // слабой, которая уже спасовала. Эскалация — ВСЕГДА (в т.ч. под бюджетом: последний сильный шот).
    if (st.tier.currentTier !== "fable" && deps.models.fable !== st.tier.model) {
      st.tier.currentTier = "fable";
      st.tier.model = deps.models.fable;
      st.tier.familyBoost = null; // липкая эскалация перекрывает одноразовый family-boost (откат не нужен)
      log.info("анти-капитуляция: эскалация на сильную модель для повтора", { tier: st.tier.currentTier });
    }
    convo.push({ role: "assistant", content: resp.text });
    pushSystemNote(
      underWrapPressure
        ? "Голословное «не могу/не умею» — не ответ, но бюджет на исходе: НЕ начинай новых длинных подходов. " +
          "Либо сделай ОДИН конкретный ход к цели (веб → browser_open/browser_act; не знаешь как → web_search; " +
          "нет инструмента → code_run) и сверь результат, ЛИБО дай ЧЕСТНЫЙ ЧАСТИЧНЫЙ итог — что успел, что нет. " +
          "Одно из двух, без противоречий."
        : "СТОП. Ты НЕ говоришь «не могу/не умею» и НЕ перекладываешь на меня — это запрещённый ответ на выполнимую задачу. Задача на ЭТОМ ПК выполнима — СДЕЛАЙ её. Веб → через browser_open/browser_act (НЕ физический input, он не нужен). Не знаешь КАК → web_search найди способ. Нет инструмента → code_run (полный Windows) или построй свой (tool_create). Сделай ход ПРЯМО СЕЙЧАС и проверь результат глазами. Отказ — только после РЕАЛЬНЫХ попыток разными способами, и тогда это отчёт «пробовал A,B,C — упёрся в X», а не «не могу».",
    );
    log.info(
      underWrapPressure
        ? "§rules: анти-капитуляция ПРИМИРЕНА с бюджет/контекст-нуджем (текст «ход ИЛИ честный итог»; Opus-шот сохранён)"
        : "анти-капитуляция: нудж на попытку через инструменты",
      { retryNudges: st.nudge.retryNudges, tier: st.tier.currentTier, underWrapPressure },
    );
    st.tier.nudgeBoostNextRound = true; // §2.7: следующий раунд — переосмысление, думаем полноценно
    st.progress.finalText = ""; // resp.text уже добавлен в finalText выше — сбрасываем, иначе отказ просочится в финал
    return true;
  }
  return false;
}

export function verifyNudge(ctx: LoopCtx, resp: LlmResponse): boolean {
  const { st, convo, pushSystemNote, escalateForQuality } = ctx;
  const { MAX_VERIFY_NUDGES } = ctx.cfg;
  // VERIFY-нудж (анти-выдумка): заявил НАБЛЮДАЕМЫЙ результат («результаты/первый/на экране/вижу»), но
  // после последнего меняющего действия НЕ сверил глазами → заставляем подтвердить чтением/скрином,
  // прежде чем принять как «готово». Кап отдельный (1). Простое «открыл/запустил» сюда не попадает.
  // P0.2: ТРИГГЕР СТРУКТУРНЫЙ — висит несверённое СЛЕПОЕ действие (клик/ввод/act/фокус), а модель
  // собирается закрыть ход. Раньше требовался ещё regex claimsObservedResult(text) → «Готово,
  // музыка играет» (без слов-маркеров) проходил без сверки. Теперь claim — лишь усилитель
  // формулировки, а сама сверка обязательна после слепого действия без наблюдения исхода.
  if (
    resp.stopReason === "end_turn" &&
    st.nudge.verifyNudges < MAX_VERIFY_NUDGES &&
    st.honesty.blindMutatePending
  ) {
    st.nudge.verifyNudges += 1;
    // QUALITY-эскалация: слабый тир заявил «готово» по слепому действию и ПОСЛЕ первого напоминания
    // СНОВА не сверил исход (2-й verify-нудж) → сильная модель верифицирует надёжнее. Не на 1-м
    // (первый — нормальный ход), а на повторном промахе — сигнал недо-тщательности, не просто медленной сверки.
    if (st.nudge.verifyNudges >= 2) escalateForQuality("повторный промах сверки исхода");
    const claimed = claimsObservedResult(resp.text);
    convo.push({ role: "assistant", content: resp.text.trim() || "…" }); // аудит [2]: пустой content → Anthropic 400 (как sibling ниже)
    pushSystemNote(
      claimed
        ? "Стоп. Ты заявил результат, но НЕ сверил его глазами после последнего действия — мог выдумать. СВЕРЬ ФАКТОМ, дешёвое прежде дорогого (лестница §Волна3): look{what:'elements'} (нативное окно) / browser_read / browser_inspect (веб) / look{what:'text'} (текст с canvas/игры) / screen_capture (последний резерв) — и убедись, что цель РЕАЛЬНО достигнута. Достигнута → подтверди тем, что реально увидел. НЕ достигнута → зайди другим способом и доведи. Содержимое не сочиняй."
        : "Стоп. Ты сделал действие, но НЕ проверил исход — клик/ввод/команда могли не сработать (регион, нет элемента, потерян фокус). Прежде чем сказать «готово», СВЕРЬ РЕАЛЬНЫЙ результат дешёвым сенсором (лестница §Волна3): look{what:'elements'} (нативное окно) / browser_read / browser_inspect (веб) / look{what:'text'} (canvas/игра) / screen_capture (последний резерв). Цель достигнута → подтверди фактом, что увидел. НЕ достигнута → зайди другим способом и доведи, не сдавайся.",
    );
    log.info("verify-петля: нудж на сверку результата глазами", { verifyNudges: st.nudge.verifyNudges, claimed });
    st.tier.nudgeBoostNextRound = true; // §2.7: следующий раунд — переосмысление, думаем полноценно
    st.progress.finalText = "";
    return true;
  }
  return false;
}

export function goalCheck(ctx: LoopCtx, resp: LlmResponse, snap: RoundSnapshot): boolean {
  const { text, st, convo, pushSystemNote } = ctx;
  const { gateStoppedPrevRound } = snap;
  // §адаптация к цели (кап 1, только многошаговые): модель закрывает ход — сверяем с ИСХОДНОЙ
  // задачей. Ловит деградацию цели до подцели: «запусти поиск в доте» при незапущенной Доте →
  // запустил игру → «Готово» (живой случай). Запущенное приложение могло ещё грузиться —
  // нудж прямо говорит подождать и продолжить, а не считать запуск финалом.
  // Усиление (живой случай 2026-07-02): «запусти поиск в доте» → app_launch → screen_capture
  // (меню Доты) → «Дота запущена, сэр» — lastRoundHadVerify ГАСИЛ сверку с целью, хотя модель
  // сверила глазами ПОДЦЕЛЬ (запуск), а не цель (поиск матча). Финал, звучащий как чистый
  // запуск/открытие, проходит goal-check ДАЖЕ после verify-раунда: запуск почти никогда не цель.
  const launchOnlyClaim = /(?<![\p{L}])(запущен|запустил|поднялс|стартовал|открыл)\p{L}*/iu.test(resp.text || "");
  // Контроль-4 (режим выделения): прошлый раунд остановило СОСТОЯНИЕ системы (вуаль / §14-гейт), и модель
  // честно сообщает, что НЕ сделала («оверлей открыт — дождусь») — сверять такой финал с целью незачем:
  // «выполнена ли целиком?» уже отвечено самим текстом, а нудж лишь жёг раунд и толкал в закрытый ввод.
  // Заявка УСПЕХА после такого раунда goal-check по-прежнему проходит (гард только на give-up-тексте).
  const goalCheckRedundant = gateStoppedPrevRound && looksLikeGiveUp(resp.text);
  if (resp.stopReason === "end_turn" && !st.honesty.goalCheckDone && st.progress.round >= 2 && (!st.honesty.lastRoundHadVerify || launchOnlyClaim) && !goalCheckRedundant) {
    st.honesty.goalCheckDone = true;
    // QUALITY-эскалацию на goal-check НЕ вешаем (ревью cost): launchOnlyClaim ловит «открыл/включил» —
    // частейшее ЛЕГИТИМНОЕ голосовое завершение (round≥2 «Открыл ютуб, включил видео») → эскалация на
    // Opus жглась бы там, где задача уже сделана. Goal-check лишь НУДЖИТ сверку с целью; quality-
    // эскалация остаётся на verify-2nd-nudge (повторный промах сверки — редкий, высокосигнальный).
    convo.push({ role: "assistant", content: resp.text.trim() || "…" }); // аудит [2]: пустой content → Anthropic 400
    pushSystemNote(
      `Стоп — сверься с ИСХОДНОЙ задачей: «${text}». Выполнена ли она ЦЕЛИКОМ, или сделана только ` +
        `подготовка (запуск/открытие/фокус приложения)? Запущенная программа могла ещё грузиться — ` +
        `подожди её и продолжи до ПОЛНОГО результата. Если цель реально достигнута и сверена глазами — ` +
        `подтверди коротко, ничего не повторяя.`,
    );
    log.info("goal-check: сверка терминала с исходной целью", { round: st.progress.round });
    st.tier.nudgeBoostNextRound = true; // §2.7: следующий раунд — переосмысление, думаем полноценно
    st.progress.finalText = "";
    return true;
  }
  return false;
}

export function emptyFinalNudge(ctx: LoopCtx, resp: LlmResponse): boolean {
  const { st, convo, pushSystemNote } = ctx;
  // Пустой финал после инструментов → один нудж на содержательный ответ (см. emptyFinalNudged).
  if (!st.progress.finalText && st.progress.toolTrajectory.length > 0 && !st.nudge.emptyFinalNudged) {
    st.nudge.emptyFinalNudged = true;
    convo.push({ role: "assistant", content: resp.text.trim() || "…" }); // пустой content нельзя (API 400)
    pushSystemNote(
      "Ты закрыл ход БЕЗ финальной реплики. Ответь сейчас ОДНИМ содержательным сообщением: сам ответ/итог по исходной задаче (не «Готово» и не пересказ действий).",
    );
    log.info("пустой финал после инструментов — нудж на содержательный ответ");
    st.tier.nudgeBoostNextRound = true; // §2.7: следующий раунд — переосмысление, думаем полноценно
    return true;
  }
  return false;
}
