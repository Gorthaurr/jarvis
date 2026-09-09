// W3 «Петля»: до первого раунда: admission-очередь GUI-задач (§Волна2 2.5) и быстрый реплей макроса (§8).
import { log, appendUserNote, REPLAY_MACRO_SERVER_TIMEOUT_MS, replayUnsafe, emitTaskStatus } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { RecalledSkill } from "../../../memory/skills.js";
import type { ActionKind, SkillStep } from "@jarvis/protocol";
import { kindNeedsInput } from "../../tools/input-kinds.js";
import { MACRO_NOTE_MARKER } from "../checkpoint.js";
import { prefillNeedsLlmSteps } from "../skill-prefill.js";
import { autoReplayBlocked } from "../replay-gate.js";
import { verbalize } from "../../verbalize/index.js";
import { costUsd } from "../../../obs/pricing.js";

export function replayGate(ctx: LoopCtx) {
  const { text, opts, st, task, isConversational, recalled } = ctx;
  // §Волна3: + ui.invoke/ui.ground (детерминированные UIA-шаги с expect) + app.launch/browser.open
  // (самоподтверждаются) — раньше реплей умел только фокус/клик/клавиши/паузу.
  const REPLAY_SAFE = new Set([
    "app.focus", "app.launch", "browser.open",
    "ui.invoke", "ui.ground",
    "input.click", "input.key", "input.type", "input.mouse",
    "wait", "ground", "verify",
  ]);
  let replaySteps = recalled?.steps ?? [];
  // §P0 ГЕЙТ АВТО-РЕПЛЕЯ (форензика 2026-07-14: ~10 из 15 реплеев запущены чужой/разговорной речью —
  // «мат в Discord» → «закрыть приложение» sim 0.831, «разговор о базе» → 14-шаговый макрос). Слепые
  // жесты требуют: sim ≥ порога, командный глагол, НЕ-разговор, явное «Джарвис», не мета-навык.
  // Причина блокировки логируется (наблюдаемость) — recall-подсказка в промпт при этом остаётся.
  const replayGateReason =
    recalled && (recalled.steps?.length ?? 0) >= 2
      ? autoReplayBlocked({
          text,
          recalled: {
            name: recalled.name,
            when: recalled.when,
            recallSim: recalled.recallSim,
            recallSimRaw: recalled.recallSimRaw,
          },
          conversational: isConversational,
          viaWake: opts?.viaWake,
          resuming: Boolean(opts?.resumeFrom), // волна C: часть процедуры уже отработала прошлым заходом
        })
      : null;
  if (recalled && replayGateReason)
    log.info("§P0 авто-реплей заблокирован гейтом (подсказка навыка в промпте остаётся)", {
      id: recalled.id,
      reason: replayGateReason,
      sim: recalled.recallSim,
      rawCos: recalled.recallSimRaw,
    });
  const replayable =
    recalled &&
    !replayGateReason &&
    !recalled.fromShared &&
    !recalled.needsReview &&
    // §Волна2 (2.5, ревью): очередь не дождалась аренды / отменили в очереди → НИКАКИХ реальных
    // GUI-действий (реплей под терминалом «так и не приступил» был бы ложью в обе стороны).
    !st.exit.queueTimedOut &&
    !task.cancel.cancelled &&
    replaySteps.length >= 2 &&
    replaySteps.every((s) => REPLAY_SAFE.has(s.action)) &&
    replaySteps.some((s) => s.action.startsWith("input.") || s.action === "ui.invoke") &&
    // Ревью Волны 3 (#5): детерминированный реплей browser.open/app.launch идёт клиентом через
    // apps.launchApp → Start-Process ЛЮБОЙ URI-схемы (file:/ms-msdt:/search-ms:) МИМО SSRF/URL-гарда
    // сервера. Отравленный навык (prompt-injection→skill_save) шелл-открыл бы опасную схему без единого
    // LLM-раунда. Есть подозрительный URI → реплей отменяем (обычная петля идёт через гардированный
    // browser_open). Ревью Волны 3 (#7): навык, где модель СОЧИНЯЕТ текст (needsLlm/prefill input.type)
    // и тут же ШЛЁТ его (Enter/Ctrl+Enter), при слепом реплее отправил бы сообщение мимо send-гардов
    // (confirm/cadence/получатель) — тоже отменяем реплей, задача идёт через гардированный telegram_send.
    !replayUnsafe(replaySteps) &&
    !/\{\{\s*[\w-]+\s*\}\}/u.test(JSON.stringify(replaySteps));
  return { replaySteps, replayable };
}

export async function runReplay(ctx: LoopCtx, recalled: RecalledSkill, replaySteps: SkillStep[]): Promise<void> {
  const { deps, session, text, st, task, taskId, convo, ensureInput, notePartial } = ctx;
  let note: string;
  try {
    // §Волна3 (3.1): needsLlm-шаги («сочинить по месту») заполняет дешёвый тир ОДНИМ вызовом.
    // null = не заполнилось → реплей отменяем (не исполняем вслепую), идём обычной петлёй.
    // Ревью Волны 3 (#8): расход префилл-вызова УЧИТЫВАЕТСЯ в SpendGuard/метриках (иначе COGS и
    // потолок трат недосчитывали реальные вызовы LLM).
    const prefilled = await prefillNeedsLlmSteps(
      {
        llm: deps.llm,
        model: deps.models.sonnet,
        onUsage: (u) => {
          deps.spend.recordStep(taskId);
          deps.spend.recordUsage(taskId, u.inputTokens + u.outputTokens, costUsd(deps.models.sonnet, u));
          deps.usageSink?.({ taskId, model: deps.models.sonnet, usage: u, costUsd: costUsd(deps.models.sonnet, u), kind: "prefill", channel: "api" });
        },
      },
      text,
      recalled.name,
      replaySteps,
    );
    if (!prefilled) throw new Error("needsLlm-шаги не заполнились — реплей вслепую запрещён");
    // Ревью фиксов (#2): гарды выше проверяли ОРИГИНАЛЬНЫЕ шаги — префилл только что заполнил
    // пустые params (combo/url/app в том числе) и мог сделать безопасный навык опасным
    // (needsLlm input.key с пустым combo → «enter»; browser.open с пустым url → «file:///…»).
    // Перепроверяем ЗАПОЛНЕННЫЕ шаги тем же гардом — иначе оба гарда (#5/#7) обходимы префиллом.
    if (replayUnsafe(prefilled)) throw new Error("после префилла шаги небезопасны для слепого реплея (URI/отправка)");
    replaySteps = prefilled;
    if (!(await ensureInput())) throw new Error("ввод занят другой задачей (таймаут аренды)");
    if (task.cancel.cancelled) throw new Error("cancelled");
    const t0 = Date.now();
    // Ревью Волны 3 (#2, «два писателя в GUI»): клиентский runSkill сам укладывается в БЮДЖЕТ
    // (SKILL_REPLAY_BUDGET_MS, см. actuators) и честно возвращает результат ДО этого таймаута —
    // серверный потолок держим СТРОГО ВЫШЕ бюджета+сети, чтобы реальный итог клиента ВСЕГДА выиграл
    // гонку. Иначе таймаут форсил бы обычную петлю (клики моделью) ПАРАЛЛЕЛЬНО ещё идущему реплею.
    const res = await session.sendAction(
      { kind: "skill.execute", skillId: recalled.id, version: recalled.version, steps: replaySteps, params: {} },
      REPLAY_MACRO_SERVER_TIMEOUT_MS,
    );
    // Контроль-4: шаги ДО остановки исполнены (мутации!) — врезка обязана их назвать, иначе модель
    // (и «доделай» по журналу) повторит напечатанное/отправленное. Метка «УЖЕ ВЫПОЛНЕНЫ» — сигнал для
    // секции «СДЕЛАНО» чекпойнта.
    const macroK = !res.ok && typeof res.stepIndex === "number" ? res.stepIndex : 0;
    const macroDone =
      (macroK > 0 ? ` Шаги 1..${macroK} УЖЕ ВЫПОЛНЕНЫ — не повторяй их, продолжай с шага ${macroK + 1}.` : "") +
      // Контроль-5 (S1): вуаль поймала ретрай/сверку — действие шага уже инжектировано, исход неизвестен.
      (!res.ok && res.stepActionInjected === true
        ? ` Действие шага ${macroK + 1} УЖЕ УШЛО в GUI, сверить его исход под вуалью нельзя — ИСХОД НЕИЗВЕСТЕН: сверь, не повторяй вслепую.`
        : "");
    note = res.ok
      ? `${MACRO_NOTE_MARKER} навыка «${recalled.name}» v${recalled.version} уже ОТРАБОТАЛ за ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}с (${replaySteps.map((s) => s.action).join(" → ")}). ` +
        `НЕ повторяй эти шаги. Реплей слепой: сверь результат глазами (screen_capture) — цель достигнута → ` +
        `коротко подтверди; не достигнута → добей по процедуре навыка.`
      : res.error?.code === "overlay_drawing"
        ? `${MACRO_NOTE_MARKER} навыка «${recalled.name}» НЕ выполнился: поверх экрана вуаль режима выделения ` +
          `(физический ввод не инжектируется, пока открыт оверлей) — это состояние системы, не сбой навыка и не ` +
          `«экран изменился». Дождись закрытия оверлея (или спроси владельца) и тогда действуй по процедуре; ` +
          `шаги вслепую не повторяй.${macroDone}`
      : `${MACRO_NOTE_MARKER} навыка «${recalled.name}» упал (${res.error?.message ?? res.error?.code ?? "runtime"}` +
        `${res.stepIndex !== undefined ? `, шаг ${res.stepIndex + 1}` : ""}) — вероятно, приложение не запущено ` +
        `или экран изменился. Выполни задачу по процедуре навыка обычным путём.${macroDone}`;
    log.info("§8 макрос: быстрый реплей", { id: recalled.id, ok: res.ok, ms: Date.now() - t0 });
    if (!res.ok && res.error?.code === "overlay_drawing") {
      // Контроль-3: реплей лёг об вуаль — не капитуляция и не успех (те же признаки, что у tool-раунда).
      st.honesty.overlayDeniedAny = true;
      st.honesty.gateStoppedRound = true;
      st.honesty.gateStoppedByVeil = true;
      st.honesty.overlayPartialSteps = macroK;
      notePartial("macro", macroK); // контроль-9: макрос — ТАКОЙ ЖЕ источник, иначе его вклад стирало присваивание
      if (res.stepActionInjected === true) st.honesty.overlayActionInjected = true;
    }
  } catch (e) {
    note = `${MACRO_NOTE_MARKER} навыка не выполнился (${e instanceof Error ? e.message : String(e)}) — действуй по процедуре навыка.`;
    log.warn("§8 макрос: быстрый реплей не выполнился", { id: recalled.id, error: e instanceof Error ? e.message : String(e) });
  }
  // Вклеиваем итог реплея в ХВОСТ последнего user-сообщения (как steer §20) — convo обязан
  // оканчиваться пользователем, второй user-ход подряд не плодим. ⚠️ НЕ через pushSystemNote:
  // реплей СОВЕРШИЛ мутации напрямую (минуя tool_use), и это единственная их запись — журнал
  // продолжения обязан её видеть (по MACRO_NOTE_MARKER она идёт в секцию «СДЕЛАНО»).
  appendUserNote(convo, note);
}

export async function fastReplay(ctx: LoopCtx): Promise<void> {
  // ── §8 МАКРОС, быстрый путь (§Волна3 3.1 — «реплей прежде петли», расширен): у recall'нутого
  // навыка есть авто-реплей → гоним ЕГО ($0, секунды), LLM остаётся одна сверка глазами. Провал
  // реплея — честный откат на полную процедуру с контекстом «дошёл до шага N». Гейты: только СВОЙ
  // навык, только безопасные действия (никаких guard-шагов), без незаполненных {{слотов}};
  // needsLlm-шаги ЗАПОЛНЯЮТСЯ дешёвым тиром ДО реплея (skill-prefill, закрывает TODO M4+) —
  // не заполнились → реплей честно отменяется. Аренда ввода — как у обычной GUI-задачи.
  const { recalled } = ctx;
  const { replaySteps, replayable } = replayGate(ctx);
  if (replayable && recalled) await runReplay(ctx, recalled, replaySteps);
}

export async function admitGuiTask(ctx: LoopCtx): Promise<void> {
  const { deps, session, sink, st, task, taskId, tasks, arbiter, recalled, showStatus } = ctx;
  const { QUEUE_WAIT_MS } = ctx.cfg;
  // ── §Волна2 (2.5) ADMISSION-ОЧЕРЕДЬ GUI-задач: заранее ИЗВЕСТНО (по recall-навыку), что задача
  // начнётся с GUI-шагов, а аренда ввода ЗАНЯТА другой задачей → НЕ жжём LLM-раунды стоя в очереди:
  // честный state=queued (чип «в очереди»), ОДИН ack голосом («Сначала закончу текущее»), ожидание
  // аренды ДО первого раунда — потолок задачи тикает с реальной работы. Детекция эвристична (нет
  // навыка → признак молчит → страховка Волны 1: queue-aware дедлайн внутри ensureInput). Только
  // фоновый путь (!sink): синхронный чат/dev.text очередью не блокируем. Cancel в очереди работает:
  // «отмени» мутирует task.cancel — по получении аренды сразу отдаём её, петля выйдет по cancel.
  {
    const guiBoundByRecall = Boolean(recalled?.steps?.some((s) => kindNeedsInput(s.action as ActionKind)));
    if (arbiter?.locked && guiBoundByRecall && !sink && !task.cancel.cancelled) {
      tasks.markQueued(taskId);
      showStatus(); // чип «в очереди» сразу — панель видит честное состояние, не «running»
      log.info("§Волна2 admission: GUI-задача встала в очередь за арендой ввода", { taskId, title: task.title });
      if (deps.speakResult && !deps.isClosed?.()) {
        st.progress.spokeAny = true;
        deps.speakResult({ voice: verbalize("Сначала закончу текущее, сэр.") });
      }
      const t0 = Date.now();
      const got = await arbiter.acquireWithTimeout(QUEUE_WAIT_MS);
      const waited = Date.now() - t0;
      st.budget.queueWaitMs += waited;
      st.budget.loopStartMs += waited; // очередь не сжигает потолок задачи (механика Волны 1)
      if (!got) {
        st.exit.queueTimedOut = true;
      } else if (task.cancel.cancelled) {
        arbiter.release(); // отменили, пока стояли в очереди — аренду не держим, петля выйдет по cancel
      } else {
        st.progress.holdsInput = true;
        // Форс свежего взгляда: после долгой очереди экран устарел — слепые действия ждут сверки (Волна 1).
        st.budget.lastAcquireWaitMs = waited;
        tasks.start(taskId); // queued → running
        emitTaskStatus(session, task);
        log.info("§Волна2 admission: аренда получена, задача стартует", { taskId, waitedMs: waited });
      }
    }
  }
}

export async function runAdmission(ctx: LoopCtx): Promise<void> {
  const { st, isConversational, showStatus } = ctx;
  await admitGuiTask(ctx);
  // ВНЕШНИЙ КОНТРАКТ ПРОГРЕССА (аудит окружения 2026-07-21; правки ревью F10/F11): чип уходит на клиент
  // СРАЗУ при старте содержательной (не conversational) задачи — не дожидаясь первого tool-раунда (тот
  // 2-13с на Sonnet/Opus). Раньше первый показ был на :2141 ПОСЛЕ первого tool-use → лаг на всю генерацию,
  // а текст-ход (0 инструментов) не показывал чип ВОВСЕ. Место выбрано ПОСЛЕ admission-блока и ВНУТРИ try:
  // (F10) очередная GUI-задача уже показала queued выше — не мигаем running перед queued; (F11) любой throw
  // сборки промпта ниже ловится try → терминал корректно скроет чип (не осиротеет). shown уже true у
  // queued-пути → не дублируем. Разговорный ход чипа НЕ получает (не §20-задача, isSubstantiveTask=false).
  if (!isConversational && !st.progress.shown) showStatus();
  await fastReplay(ctx);
}
