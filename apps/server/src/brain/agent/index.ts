/**
 * Агент-цикл brain (§7, §8, §15, §21).
 *
 * Поток:
 *   1. classifyTier (router §7). tier0 «открой/запусти X» → ActionCommand round-trip (M0).
 *   2. Иначе — agent-loop на выбранном тире:
 *      retrieval из эпизодической памяти (§8) → системный промпт (персона §11 + факты)
 *      → LLM с инструментами (§6, §12) → исполнение tool-use (dispatchTool) → повтор
 *      до финального текста. Предохранитель — SpendGuard (max шагов/токенов §14).
 *   3. Финальный текст → verbalize (§21) → {voice, display?}.
 *
 * Эскалация тира (§7): тир выбирается ДО генерации (Haiku-классификатор/эвристика);
 * если сложность всплыла в петле — это место для филлера «секунду» и продолжения на
 * старшем тире (// TODO: динамическая эскалация).
 */
import type { ActionCommand } from "@jarvis/protocol";
import { actionTimeoutMs } from "@jarvis/protocol";
import { type AsyncMutex, type Tier, envInt } from "@jarvis/shared";
import { cleanDisfluency } from "../nlu/disfluency.js";
import { buildActionLogEntry, insertActionLog } from "../../db/action-log.js";
import type { Session } from "../../gateway/session.js";
import { type TaskCheckpoint } from "./checkpoint.js";
import { type LocalIntent, type RouteDecision, classifyTier } from "../router/index.js";
import { failurePhrase, successPhrase } from "../verbalize/action-phrases.js";
import { promoteRace } from "./sync-promote.js";
import { tier0FailureVoice, tier0FallbackNote } from "./tier0-failure.js";
import { verbalize } from "../verbalize/index.js";
import { TaskManager } from "../tasks/manager.js";
import { classifyTaskScope } from "../tasks/scope.js";
import { type Task } from "../tasks/task.js";
import { createLoopState } from "./loop/state.js";
import { log, CHARS_PER_TOKEN, estimateResultTokens, replayUnsafe, waitWhilePaused, waitForChannel, markCacheBreakpoint, type ToolRoundAwareSink } from "./loop/util.js";
import type { AgentReply, ReplySink, AgentDeps } from "./types.js";
import { loadLoopConfig } from "./loop/config.js";
import { TURN_INTERCEPTS, type TurnCtx, type TurnMeta } from "./turn-intercepts.js";
import { buildLoopContext } from "./loop/context.js";
import { armAckTimer } from "./loop/ack-timer.js";
import { runAdmission } from "./loop/admission.js";
import { runStep } from "./loop/step.js";
import { computeOutcome } from "./loop/outcome.js";
import { finalizeTask } from "./loop/finalize.js";
import { selectTerminal } from "./loop/terminal.js";
import type { LoopOpts } from "./types.js";
export { CHARS_PER_TOKEN, estimateResultTokens, replayUnsafe, waitForChannel, waitWhilePaused, markCacheBreakpoint } from "./loop/util.js";
export type { AgentReply, ReplySink, UsageSinkEvent, AgentDeps } from "./types.js";


export async function handleUserText(
  session: Session,
  text: string,
  deps: AgentDeps,
  sink?: ReplySink,
  // §P0 (гейт авто-реплея): метаданные хода от голосового пайплайна. viaWake=false — реплика принята
  // КАТЯЩИМСЯ ОКНОМ разговора без «Джарвис» (главный вход чужой речи, форензика 2026-07-14) → слепой
  // авто-реплей макроса запрещён. undefined (dev.text/чат/тесты) = явное обращение.
  // origin="watch-action" (адверс-ревью 2026-07-28 [6][20][24]): МАШИННЫЙ реэнтри сервиса наблюдений —
  // НЕ речь владельца: обходит steer/дубль-гейты активной задачи (глагол правки в поручении уводил его
  // в ЧУЖУЮ задачу с ложным «Принял, поправляю» — поручение не исполнялось) и НЕ съедает висящее
  // уточнение консьержа (pendingClarify остаётся для НАСТОЯЩЕГО ответа владельца).
  meta?: TurnMeta,
): Promise<AgentReply> {
  // §10 realtime: если задан sink — реплика отдаётся пофразно. Короткие/детерминированные
  // пути (имя/режим/tier0/фоновый ack) стримить нечего — финализируем целиком через done()
  // (он сам произнесёт voice, если ничего не стримилось). runAgentLoop стримит сам.
  const finishReply = (reply: AgentReply): AgentReply => {
    // Логируем ИМЕННО произносимый текст — чтобы можно было читать живой диалог (реплики
    // пользователя уже в логах от STT). Без этого «почитать, что отвечал Джарвис» неоткуда.
    if (reply.voice.trim()) log.info("Джарвис →", { voice: reply.voice });
    if (sink) {
      if (reply.display) sink.display(reply.display);
      sink.done(reply.voice);
    }
    return reply;
  };
  // Причесать спонтанную речь (§10): убрать запинки/повторы/обрывки/«не X, а Y» — чтобы
  // оговорки понимались и в детерминированном tier0, и в LLM. Если чистка выела всё
  // (фраза была одной хезитацией) — оставляем оригинал, не теряем ход.
  const clean = cleanDisfluency(text.trim()) || text.trim();
  deps.memory.pushTurn("user", clean);

  // ПАМЯТЬ — ОСОЗНАННАЯ, не свалка транскриптов. Раньше СЮДА писалась КАЖДАЯ реплика как «event»
  // (включая STT-мусор, команды, обрывки) → потом всплывала в приветствии/контексте как «странные
  // воспоминания, которых я не говорил». Теперь Джарвис сохраняет в память ТОЛЬКО осознанно —
  // через memory_write значимые факты/привычки/предпочтения (см. персона §8). Так память про
  // «образ жизни» остаётся точной и чистой, а не зашумлённой каждой сказанной фразой.

  // §20 параллельность: если УЖЕ выполняется фоновая задача, различаем — это правка той задачи
  // («добавь раздел») или НОВОЕ отдельное дело («а ещё закажи такси»). Новое дело запускаем со
  // СВЕЖИМ контекстом (не тянем диалог текущей задачи) → «обособленная» задача не путается с
  // текущей. Правка — наследует контекст (продолжение). Только при активной задаче; env-выключатель.
  const scopeEnabled = (process.env.JARVIS_TASK_SCOPE ?? "1") !== "0";
  // HIGH-3 (ревью 2026-07-10): активная задача — по USERID, не sessionId: после reconnect sessionId
  // новый, и scope/steer/дубль-гейт не видели живую задачу старой сессии (реплики плодили дубли).
  const activeTask = scopeEnabled ? deps.tasks?.activeForUser(deps.userId)[0] : undefined;
  // Машинный реэнтри (watch-action) — всегда ОТДЕЛЬНОЕ дело со свежим контекстом: scope/steer/дубль-гейты
  // калиброваны под ЖИВУЮ речь (STT-шум/правки/повторы) и к сгенерированному поручению неприменимы.
  const machineTurn = meta?.origin === "watch-action";
  // Цель ИМЕННО той задачи, в которую полетит steer — классификатор гейтит «edit» связью с её
  // объектом (иначе реплика на другую тему уезжала в чужую задачу под ложное «Принял, поправляю»).
  const freshContext =
    Boolean(activeTask) && (machineTurn || classifyTaskScope(clean, activeTask?.goal ?? "") === "new");

  const t: TurnCtx = { session, deps, sink, meta, text, clean, finishReply, machineTurn, activeTask, freshContext, run: { runTier0, runAgentLoop, runActionSyncFirst, startBackgroundTask } };
  for (const intercept of TURN_INTERCEPTS) {
    const reply = await intercept(t);
    if (reply) return reply;
  }

  const decision = confirmationAware(classifyTier(clean), deps.memory);
  log.info("маршрутизация", { tier: decision.tier, reason: decision.reason });
  let tier0FellBack = false;
  // T-F5: причина провала быстрого пути — в контекст хода модели (служебной врезкой, не репликой владельца).
  let priorFailure: string | undefined;

  // tier0 (запуск/фокус/сайт) — детерминированно, без LLM. Под арендой ввода (§20):
  // свободна → инлайн (мгновенно), занята фоновой задачей → не крадём фокус.
  if (decision.tier === "tier0" && decision.local) {
    // Консьерж: голая команда-сервис → мгновенный короткий вопрос + ждём ответ (НЕ действие).
    if (decision.local.kind === "clarify") {
      deps.memory.pushTurn("assistant", decision.local.question);
      deps.pendingClarify = { key: decision.local.key };
      return finishReply({ voice: decision.local.question });
    }
    const t0: Tier0Reply = await runTier0(session, decision.local, deps, sink, clean);
    if (!t0.fallbackToLlm) return finishReply(t0);
    priorFailure = t0.fallbackNote;
    // Приложение по имени не нашлось → модель решает, что это было («тесты», «стрим», «сервер») — как
    // ЗАДАЧА-ДЕЙСТВИЕ (sonnet), не как болтовня. Раньше здесь был терминал «не нашёл» без второго шанса.
    // Не только app.launch: «сними выделение» без нашей рамки тоже уходит модели — лог называет вид интента.
    log.info(`tier0: ${decision.local.kind} не закрыт детерминированно — передаю модели`, {
      app: (decision.local as { app?: string }).app,
      op: (decision.local as { op?: string }).op,
    });
    tier0FellBack = true;
  }
  const tier: Exclude<Tier, "tier0"> = decision.tier === "tier0" ? (tier0FellBack ? "sonnet" : "haiku") : decision.tier;

  // §15 Семантический кэш ответа: на близкий ФАКТИЧЕСКИЙ вопрос, на который уже был чисто-вербальный
  // ответ, отдаём кэш СРАЗУ — без вызова LLM (мгновенно, $0). Безопасно: кэшируются лишь ходы без
  // tool-use (см. store) → реплей не врёт «сделано»; lookup сам отсекает непригодные/командные запросы.
  // 🔴 СТРУКТУРНЫЙ ГАРД (живой прогон волны D): «отмени напоминание про таблетки» получило ОТВЕТ ИЗ
  // КЭША (sim 1.0) — команда НЕ ИСПОЛНИЛАСЬ, а владельцу озвучили утверждение о состоянии, которого
  // уже нет («их два — в 9 утра и в 9 вечера»). Денилист `isCacheableQuery` дыру не закрыл и закрыть
  // не может (стем «напомн» не ловит «напомин-а-ние», «отмен» вообще не было) — денилист принципиально
  // неполон, ровно как в lean-smalltalk. Поэтому решает ПОЛОЖИТЕЛЬНЫЙ признак роутера: кэш работает
  // ТОЛЬКО на РАЗГОВОРНОМ ходе (вопрос). Всё, что роутер счёл действием, идёт в петлю всегда.
  // §режим выделения: пока владелец на что-то ПОКАЗЫВАЕТ, кэш ответов молчит. Дейктический вопрос
  // («что тут не так?») звучит одинаково для РАЗНЫХ областей — ответ из кэша описывал бы прошлую
  // картинку как нынешнюю. Это уже случавшийся боевой класс (кэш подсунул устаревший состав списка).
  const selectionAtStart = Boolean(deps.selection?.get());
  // T-F6: короткая РЕАКЦИЯ («нет, не надо») целиком зависит от того, на что отвечает, — ответ из кэша был бы
  // ответом на ДРУГУЮ реплику Джарвиса. Кэш — только для вопросов, реакции идут к модели всегда.
  if (deps.responseCache && decision.conversational === true && !selectionAtStart && !decision.reaction) {
    const cached = await deps.responseCache.lookup(deps.userId, clean);
    if (cached) {
      deps.memory.pushTurn("assistant", cached);
      return finishReply({ voice: cached });
    }
  }

  // SYNC-FIRST (корень жалобы «молча делал → потом скопом ответил на всё»): ДЕЙСТВИЕ исполняем
  // СИНХРОННО этим же ходом — итог звучит СРАЗУ, а не «молча в фон → отложенный итог → очередь
  // сливается скопом». Длинную задачу ПРОМОТИМ в фон по бюджету (JARVIS_SYNC_PROMOTE_MS): короткая
  // (открой/пауза/один шаг) → мгновенный голосовой результат; затянувшаяся → ОДНА фраза «Берусь, сэр»
  // (не молчание!) + фон + итог по готовности, микрофон при этом освобождается (не глохнет — прежняя
  // причина async-всего). ВОПРОС (conversational) и так шёл синхронно ниже. Аварийный откат к старому
  // «всё в фон» — JARVIS_SYNC_FIRST=0. Без sink (dev.text/тесты) — просто синхронный путь ниже.
  const isActionTask = decision.conversational !== true && (tier === "sonnet" || tier === "fable");
  if (isActionTask && deps.speakResult) {
    if (sink && process.env.JARVIS_SYNC_FIRST !== "0") {
      // ГОЛОСОВОЙ канал: sync-first с промоушеном в фон — текстовый ответ модели звучит СРАЗУ, а ход, ушедший
      // в инструменты, говорит «Берусь» и уходит в фон (микрофон свободен). Это и есть фикс «молча → скопом».
      return await runActionSyncFirst(session, clean, tier, deps, sink, { freshContext, viaWake: meta?.viaWake, machine: machineTurn, priorFailure });
    }
    // Без sink (dev.text/чат/тесты) ИЛИ откат JARVIS_SYNC_FIRST=0: прежнее — молча в фон, итог через
    // speakResult (в тексте нет аудио-очереди → скопом не сливается; сеанс не блокируется на длинной задаче).
    deps.taskAccepted?.();
    const preTask = queuedPreTask(session, clean, deps);
    startBackgroundTask(() => runAgentLoop(session, clean, tier, deps, undefined, { freshContext, viaWake: meta?.viaWake, machine: machineTurn, selectionAtStart, preTask, priorFailure }), deps, { bounded: true, preTask });
    return finishReply({ voice: "" });
  }

  // haiku-болтовня / нет асинхронного канала (тесты) → синхронно. С sink — стримим пофразно
  // (§10): первый звук = синтез первого предложения, не всей реплики. done() вызовет finishReply.
  // conversational: вопрос/рассуждение — от хода НЕ ждём «дела» (mutate); маскированный провал
  // («Не вышло») на таком ходе — ложь в обратную сторону (живой случай: «сколько будет 2+2» +
  // tool_load → пустой финал → «нужное действие не сработало», хотя ничего не падало).
  const reply = await runAgentLoop(session, clean, tier, deps, sink, {
    freshContext,
    conversational: decision.conversational === true,
    reaction: decision.reaction !== undefined,
    selectionAtStart,
    smalltalk: decision.smalltalk === true,
    viaWake: meta?.viaWake,
    machine: machineTurn,
    priorFailure,
  });
  deps.memory.pushTurn("assistant", reply.voice);
  return finishReply(reply);
}

/** T-F5: ответ tier0 с причиной провала для модели (если ход передаётся ей). */
type Tier0Reply = AgentReply & { fallbackNote?: string };
/** T-F5: опции петли + врезка о провале быстрого пути (LoopOpts живёт в types.ts — расширяем локально). */
type RunLoopOpts = LoopOpts & { priorFailure?: string };

/** T-F6: окно, в котором «да/хорошо» после ВОПРОСА Джарвиса считается ответом на него. */
const CONFIRM_REPLY_WINDOW_MS = 5 * 60_000;

/**
 * Ревью 2026-09-24 (T-F6): короткая реакция — разговор, НО согласие («да», «давай», «хорошо») на свежий ВОПРОС
 * Джарвиса («Открыть почту в фоне?», «Отправить Кате?») — это подтверждение ДЕЙСТВИЯ: задача, а не болтовня
 * (иначе оно шло бы разговорным тиром — синхронно, с глухим микрофоном и без гейтов честности задачи).
 * Роутер контекста не знает (чистая функция от текста) — решаем здесь по рабочей памяти.
 */
function confirmationAware(decision: RouteDecision, memory: AgentDeps["memory"]): RouteDecision {
  if (decision.reaction !== "affirm") return decision;
  const turns = memory.recentTurns();
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.role !== "assistant") continue;
    if (t.text.trim().endsWith("?") && Date.now() - t.ts <= CONFIRM_REPLY_WINDOW_MS) {
      return { tier: "sonnet", reason: "согласие на вопрос Джарвиса — подтверждение действия (задача)" };
    }
    break;
  }
  return decision;
}

/**
 * tier0 «открой/запусти/переключись X» (§7). Команда трогает фокус/окно → идёт под
 * арендой ввода (§20). Аренда свободна (или её нет — тесты) → инлайн, мгновенный отзыв.
 * Занята фоновой задачей → не крадём фокус и не блокируем разговор: подтверждаем
 * по-дворецки и исполняем фоновой микро-задачей, когда аренда освободится. Без
 * асинхронного канала — честно ждём аренду и исполняем инлайн (корректность > задержки).
 */
async function runTier0(session: Session, local: LocalIntent, deps: AgentDeps, sink?: ReplySink, goal?: string): Promise<Tier0Reply> {
  const arbiter = deps.inputArbiter;
  // §20/realtime: с голосовым каналом ВСЕГДА в фон, даже если аренда свободна. Иначе медленное
  // действие (browser.open висел 12с на CDP-таймауте) держит пайплайн в «думаю», где микрофон
  // в STT не кормится → Джарвис «перестаёт слышать». Фон: «принял» сразу → пайплайн слушает →
  // действие async (аренда ввода берётся внутри runLocalIntent), итог проговорим по готовности.
  // Мгновенные глобальные действия (медиа/громкость — keybd_event, не GUI-грундинг): СИНХРОННО, БЕЗ
  // ack-филлера и БЕЗ ожидания аренды ввода. Одна чистая фраза мгновенно — не плодим «Принял»+результат
  // на быстрой команде (лечит «×2 фразы» на медиа) и не ждём, пока освободится мышь от фоновой задачи.
  // §режим выделения — тоже instant: оверлей открывается мгновенно, ждать нечего, аренда ввода не нужна
  // (рисует ВЛАДЕЛЕЦ, не мы), и дворецкий-ack тут был бы второй фразой поверх «Обводите область».
  const instant = local.kind === "media" || local.kind === "volume" || local.kind === "selection";
  // SYNC-FIRST (та же логика, что для LLM-действий): «открой X» звучит результатом СРАЗУ («Запустил
  // доту, сэр»), а не молча-в-фон-с-отложенным-итогом. Медленное открытие (browser.open висел на
  // CDP) ПРОМОТИМ в фон по бюджету — «Секунду, сэр» + итог по готовности, микрофон освобождается (та
  // же защита от «глохнет», что раньше давал безусловный фон). Откат к старому фону — JARVIS_SYNC_FIRST=0.
  if (sink && deps.speakResult && !instant && process.env.JARVIS_SYNC_FIRST !== "0") {
    const promoteMs = envInt("JARVIS_SYNC_PROMOTE_MS", TIER0_PROMOTE_DEFAULT_MS);
    const runP = runLocalIntent(session, local, arbiter, deps.isClosed, deps.openOrFocus, () => deps.selection?.drawing === true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race<{ kind: "done"; reply: AgentReply } | { kind: "error"; error: unknown } | { kind: "slow" }>([
      // onRejected — см. runActionSyncFirst: не плодим unhandled rejection при промоушене.
      runP.then((reply) => ({ kind: "done" as const, reply }), (error) => ({ kind: "error" as const, error })),
      new Promise<{ kind: "slow" }>((res) => {
        timer = setTimeout(() => res({ kind: "slow" }), promoteMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "done") {
      if (outcome.reply.fallbackToLlm) return outcome.reply; // ход продолжит модель — ассистентской реплики ещё нет
      deps.memory.pushTurn("assistant", outcome.reply.voice);
      return outcome.reply; // результат сразу этим ходом
    }
    // ПРОМОУШЕН: открытие затянулось → «Секунду, сэр» сразу, итог по готовности (микрофон свободен).
    log.info("sync-first tier0: действие затянулось — промоушен в фон");
    const bg = runP
      .then((reply) => {
        // Контроль-1 №4 (ревью 2026-09-24): провал быстрого пути ПОСЛЕ промоушена. exe-запуск ждёт ~1,5 с сверки, так
        // что голосовое «открой дискорд» почти всегда промотируется — и T-F5 («провал запуска — модели») тут не
        // работал: владелец слышал «Не смог запустить», модель не звалась. Отдаём ход модели в фоне с причиной провала.
        if (reply.fallbackToLlm && goal && !deps.isClosed?.()) {
          log.info("tier0 после промоушена не закрыт детерминированно — передаю модели в фоне", { kind: local.kind });
          const preTask = queuedPreTask(session, goal, deps);
          startBackgroundTask(() => runAgentLoop(session, goal, "sonnet", deps, undefined, { priorFailure: (reply as Tier0Reply).fallbackNote, preTask }), deps, { bounded: true, preTask });
          return;
        }
        deps.memory.pushTurn("assistant", reply.voice);
        if (reply.voice.trim() && !deps.isClosed?.()) deps.speakResult?.(reply);
      })
      .catch((e) => {
        log.error("промотированное tier0-действие упало", { error: e instanceof Error ? e.message : String(e) });
        if (!deps.isClosed?.()) deps.speakResult?.({ voice: verbalize("Не смог выполнить, сэр.") });
      });
    deps.bgTasks?.add(bg);
    void bg.finally(() => deps.bgTasks?.delete(bg));
    return { voice: verbalize("Секунду, сэр.") };
  }
  if (deps.speakResult && !instant) {
    // Откат (JARVIS_SYNC_FIRST=0): прежнее поведение — молча в фон, итог через speakResult.
    if (arbiter?.locked) deps.taskAccepted?.();
    startBackgroundTask(() => runLocalIntent(session, local, arbiter, deps.isClosed, deps.openOrFocus, () => deps.selection?.drawing === true), deps, { bounded: false });
    return { voice: "" };
  }
  // instant → без аренды; прочее (тесты/dev.text) — инлайн под арендой (корректность > задержки).
  const useArbiter = !instant ? arbiter : undefined;
  if (useArbiter) await useArbiter.acquire();
  try {
    const reply = await runLocalIntent(session, local, undefined, undefined, deps.openOrFocus, () => deps.selection?.drawing === true);
    if (!reply.fallbackToLlm) deps.memory.pushTurn("assistant", reply.voice);
    return reply;
  } finally {
    if (useArbiter) useArbiter.release();
  }
}

/**
 * Запустить фоновую задачу (§20 async). Независимые задачи бегут ПАРАЛЛЕЛЬНО — за общую
 * мышь/клаву отвечает аренда ввода (§20) внутри runAgentLoop/runLocalIntent, не глобальная
 * серия. bounded=true — под ограничителем параллельных agent-loop'ов (не спамить LLM).
 * Итог озвучивается по готовности через speakResult; в мёртвую сессию — молчим.
 */
/**
 * W0: зарегистрировать задачу ДО ожидания семафора — в состоянии queued. Раньше tasks.create жил внутри
 * runAgentLoop, то есть ПОСЛЕ sem.acquire(): пока слоты заняты, задачу не видели ни «отмени всё»
 * (cancelUser), ни дубль-гейт, ни «что делаешь» — «отмени всё» снимало три, четвёртая стартовала после
 * и исполнялась.
 */
function queuedPreTask(session: Session, goal: string, deps: AgentDeps): Task | undefined {
  if (!deps.tasks) return undefined;
  const task = deps.tasks.create({ userId: deps.userId, sessionId: session.sessionId, goal, ...(deps.devSession ? { dev: true } : {}) });
  deps.tasks.markQueued(task.taskId);
  return task;
}

function startBackgroundTask(
  run: () => Promise<AgentReply>,
  deps: AgentDeps,
  opts: { bounded: boolean; preTask?: Task },
): void {
  const sem = opts.bounded ? deps.concurrency : undefined;
  const task = (async () => {
    if (sem) await sem.acquire();
    try {
      // W0: отменили, пока стояли в очереди → не стартуем вовсе.
      if (opts.preTask && (opts.preTask.cancel.cancelled || opts.preTask.state === "cancelled")) {
        log.info("§20 задача отменена в очереди — не запускаем", { taskId: opts.preTask.taskId });
        return;
      }
      const reply = await run();
      deps.memory.pushTurn("assistant", reply.voice);
      if (reply.voice.trim() && !deps.isClosed?.()) {
        log.info("Джарвис → (фоновый итог)", { voice: reply.voice });
        deps.speakResult?.(reply);
      }
    } catch (e) {
      log.error("фоновая задача упала", { error: e instanceof Error ? e.message : String(e) });
      if (!deps.isClosed?.()) deps.speakResult?.({ voice: verbalize("Не смог выполнить, сэр.") });
    } finally {
      if (sem) sem.release();
    }
  })();
  deps.bgTasks?.add(task);
  void task.finally(() => deps.bgTasks?.delete(task));
}

/**
 * SYNC-FIRST исполнение действия на ГОЛОСОВОМ канале (корень «молча делал → потом скопом»).
 * Действие идёт СИНХРОННО с sink (первый звук — как только готово), НО как только модель ПОШЛА В ИНСТРУМЕНТЫ
 * (ревью 2026-09-24, T-F6; не раньше пола 1,5 с) или думает дольше JARVIS_SYNC_PROMOTE_MS (деф 6 с) —
 * ПРОМОТИМ в фон: финализируем ход одной фразой «Берусь, сэр» (микрофон
 * освобождается, не глохнет — прежняя причина async-всего) и доигрываем задачу в фоне, итог по
 * готовности через speakResult. Короткая задача (открой/пауза/один шаг) промоушена не достигает —
 * её результат звучит сразу этим ходом. Обёртка-sink глушит поздний стрим петли ПОСЛЕ промоушена,
 * чтобы реальный итог не прозвучал ПОВЕРХ «Берусь» (озвучится один раз через speakResult).
 */
async function runActionSyncFirst(
  session: Session,
  text: string,
  tier: Exclude<Tier, "tier0">,
  deps: AgentDeps,
  sink: ReplySink,
  opts: { freshContext?: boolean; viaWake?: boolean; resumeFrom?: TaskCheckpoint; machine?: boolean; priorFailure?: string },
): Promise<AgentReply> {
  // Fix ревью (concurrency-bound): держим потолок MAX_PARALLEL_TASKS и для sync-first. Забираем слот
  // НЕблокирующе (tryAcquire) — интерактивный ход не тормозим. Слотов нет (все заняты промотированными
  // петлями) → эту команду в bounded-фон (встанет в очередь семафора), чтобы не плодить >MAX параллельных
  // LLM-петель. Редкий burst длинных задач → деградация к прежнему тихому фону, а не перегруз/429.
  const sem = deps.concurrency;
  if (sem && !sem.tryAcquire()) {
    log.info("sync-first: слоты параллельности заняты — команда в bounded-фон (не превышаем MAX_PARALLEL_TASKS)");
    deps.taskAccepted?.();
    const preTask = queuedPreTask(session, text, deps);
    startBackgroundTask(() => runAgentLoop(session, text, tier, deps, undefined, { ...opts, preTask }), deps, { bounded: true, preTask });
    sink.done(""); // тихий финал (как прежний фон-путь)
    return { voice: "" };
  }
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      sem?.release();
    }
  };

  // T-F6/B-F1: промоушен по ФАКТУ первого tool_use (см. sync-promote.ts); верхний порог — чтобы не молчать вечно.
  const capMs = envInt("JARVIS_SYNC_PROMOTE_MS", SYNC_PROMOTE_DEFAULT_MS);
  const floorMs = Math.min(PROMOTE_FLOOR_MS, capMs);
  let detached = false;
  let onToolRound: () => void = () => {};
  // Обёртка: до промоушена — прозрачна к реальному sink; после — инертна (петля больше не стримит
  // в голосовой канал; её финал доставит speakResult). Петля зовёт только sentence/thinking (см.
  // контракт: sink.done делает ВЫЗЫВАЮЩИЙ, не петля), поэтому done тут не нужен.
  const wrap: ToolRoundAwareSink = {
    thinking: () => {
      if (!detached) sink.thinking?.();
    },
    sentence: (s) => {
      if (!detached) sink.sentence(s);
    },
    display: (d) => {
      if (!detached) sink.display(d);
    },
    done: () => {},
    onToolRound: () => onToolRound(),
  };
  // suppressStepStream (фикс double-speak): action-петля НЕ стримит step-0 пофразно в sink → нет pushedAny
  // в пайплайне ДО промоушена → «Берусь» не глохнет и итог не звучит вторым разом. Финал — один раз
  // (терминал при done / speakResult при промоушене). Разговорный путь (conversational) стрим сохраняет.
  const loopP = runAgentLoop(session, text, tier, deps, wrap, { ...opts, conversational: false, suppressStepStream: true });
  void loopP.then(release, release); // слот держим на ВСЮ жизнь петли (sync + промоушен), освобождаем на терминации
  // detached ставится В МОМЕНТ решения о промоушене (синхронно) — поздний стрим петли не успеет уйти в голос.
  const race = promoteRace(loopP, capMs, floorMs, () => {
    detached = true;
  });
  onToolRound = race.onToolRound;
  const outcome = await race.outcome;

  // До промоушена ошибка пробрасывается наверх (как в синхронном пути), после — её ловит bg.catch ниже.
  if (outcome.kind === "error") throw outcome.error; // ошибка ДО промоушена → наверх (пайплайн даст фолбэк)
  if (outcome.kind === "done") {
    // Уложились в бюджет → результат звучит СРАЗУ этим ходом (финализируем sink сами — петля done не зовёт).
    const reply = outcome.reply;
    deps.memory.pushTurn("assistant", reply.voice);
    if (reply.voice.trim()) log.info("Джарвис →", { voice: reply.voice });
    if (reply.display) sink.display(reply.display);
    sink.done(reply.voice);
    return reply;
  }

  // ПРОМОУШЕН: модель пошла в инструменты (или думает дольше порога) → «Берусь, сэр» СРАЗУ, микрофон
  // освобождается, итог в фон. T-F6: ack — ПРОАКТИВ (origin), окна разговора он не открывает: иначе, пока
  // задача идёт в фоне, звук комнаты без «Джарвис» уходил бы в петлю как команда. Пайплайн читает второй
  // аргумент done (контракт ReplySink расширяет интегратор — см. notes ревью); без него поведение прежнее.
  log.info("sync-first: промоушен в фон", { why: outcome.why, capMs, floorMs });
  sink.done(verbalize(promoteAck()), { origin: "proactive" });
  const bg = loopP
    .then((reply) => {
      deps.memory.pushTurn("assistant", reply.voice);
      if (reply.voice.trim() && !deps.isClosed?.()) {
        log.info("Джарвис → (промоушен-итог)", { voice: reply.voice });
        deps.speakResult?.(reply);
      }
    })
    .catch((e) => {
      log.error("промотированная задача упала", { error: e instanceof Error ? e.message : String(e) });
      if (!deps.isClosed?.()) deps.speakResult?.({ voice: verbalize("Не смог выполнить, сэр.") });
    });
  deps.bgTasks?.add(bg);
  void bg.finally(() => deps.bgTasks?.delete(bg));
  return { voice: "" }; // ход уже озвучил «Берусь» через sink.done выше
}

/**
 * W0 (2026-09-09): промоушен через 1,5 с, а не через 10 (41 из 86 замеров mouth-to-ear лежали ровно у 10 с).
 * Ревью 2026-09-24 (T-F6/B-F1): для ДЕЙСТВИЯ с моделью 1,5 с — это «Берусь» на КАЖДЫЙ ход (раунд подписки
 * ≥2,9 с), и на «нет, не надо» тоже. Теперь триггер — первый tool_use (sync-promote.ts), а этот порог —
 * ВЕРХНИЙ: модель думает без инструмента дольше 6 с → всё равно промоушен. Почему 6 с: одиночный раунд
 * подписки — медиана ~4,4 с, p90 ~5,1 с (замер self_weaknesses 2026-09-02), так что текстовый ответ почти
 * всегда успевает прозвучать сам; дольше — молчание уже читается как «не услышал» и провоцирует повтор
 * команды (урок волны 1: «8 с тишины → повторил → две петли»). Earcon раздумья (700 мс) закрывает паузу до
 * ответа. Env JARVIS_SYNC_PROMOTE_MS переопределяет.
 */
const SYNC_PROMOTE_DEFAULT_MS = 6_000;
/** Пол промоушена по tool_use — быстрый канал успевает ответить результатом однотулового действия (sync-promote.ts). */
const PROMOTE_FLOOR_MS = 1_500;
/** tier0 (без модели): «открой X» — прежний таймер 1,5 с, раунда модели тут нет. */
const TIER0_PROMOTE_DEFAULT_MS = 1_500;
/** T-F6: done с происхождением речи (контракт ReplySink в types.ts его пока не знает — см. notes ревью). */
/** Короткие ack промоушена — ротация, чтобы не было заученной отбивки (персона: «variety is mandatory»). */
const PROMOTE_ACKS = ["Берусь, сэр.", "Сию минуту.", "Занимаюсь.", "Сейчас сделаю.", "Принял, делаю.", "Есть, сэр."] as const;
let promoteAckIdx = 0;
function promoteAck(): string {
  const ack = PROMOTE_ACKS[promoteAckIdx % PROMOTE_ACKS.length]!;
  promoteAckIdx += 1;
  return ack;
}

/** Полный agent-loop с tool-use (§7, §8). sink (§10) — пофразный стрим финальной реплики. */
async function runAgentLoop(
  session: Session,
  text: string,
  tier: Exclude<Tier, "tier0">,
  deps: AgentDeps,
  sink?: ReplySink,
  opts?: RunLoopOpts,
): Promise<AgentReply> {
  // §10 realtime: сигналим «думаю» КАК МОЖНО РАНЬШЕ (до retrieval/recall/LLM) — пайплайн
  // замаскирует пол латентности Opus коротким филлером «Секунду, сэр.», пока идёт генерация.
  sink?.thinking?.();
  const st = createLoopState({ tier, model: deps.models[tier] });

  // Долгая задача (§20): общий с router реестр (или локальный для изолированных тестов).
  // Б6: разговорный ход (вопрос/комплимент/smalltalk) регистрируем НЕсодержательной задачей —
  // она нужна для механики петли (cancel/прогресс), но не всплывает в active()/scope/«сделал?».
  const isConversational = opts?.conversational === true;
  const tasks = deps.tasks ?? new TaskManager();
  // W0: задача могла быть зарегистрирована заранее (queued за семафором) — переводим в running, не плодим вторую.
  const task = opts?.preTask ?? tasks.create({ userId: deps.userId, sessionId: session.sessionId, goal: text, conversational: isConversational, ...(deps.devSession ? { dev: true } : {}) });
  if (opts?.preTask) tasks.start(task.taskId);
  const taskId = task.taskId;

  const cfg = loadLoopConfig(isConversational);
  const ctx = await buildLoopContext({ session, text, tier, deps, sink, opts, st, task, taskId, tasks, isConversational, cfg });
  const { arbiter } = ctx;
  // T-F5: быстрый путь (tier0) не справился — модель знает ЧТО и ПОЧЕМУ (врезка помечена как служебная, журнал
  // чекпойнта не выдаст её за речь владельца).
  if (opts?.priorFailure) ctx.pushSystemNote(opts.priorFailure);
  armAckTimer(ctx);
  // Любое исключение из шага (брошенный dispatchTool, reject провайдера) НЕ должно
  // оставить задачу в running и подвесить счётчик SpendGuard — ловим и финализируем.
  try {
    await runAdmission(ctx);
    for (let step = 0; step < cfg.HARD_STEP_CAP; step += 1) {
      if ((await runStep(ctx, step)) === "break") break;
    }
  } catch (e) {
    log.error("agent-loop: исключение в петле", { error: e instanceof Error ? e.message : String(e) });
    st.exit.failed = true;
  } finally {
    // §20: отложенный ack не должен пережить петлю (терминал сам скажет итог).
    if (st.progress.ackTimer) clearTimeout(st.progress.ackTimer);
    // Слот, занятый разговорным ходом с инструментами, освобождаем на ЛЮБОМ выходе.
    if (st.progress.convoSlotHeld) {
      st.progress.convoSlotHeld = false;
      deps.concurrency?.release();
    }
    // Освобождаем аренду ввода на ЛЮБОМ выходе (успех/отмена/лимит/исключение, §20),
    // иначе следующая задача навечно зависнет на acquire. Терминал ниже ввод не трогает.
    if (st.progress.holdsInput && arbiter) arbiter.release();
    // Волна E: страховочный снимок (70%-нудж) нужен лишь ПОКА петля может умереть без терминала.
    // Дошли сюда — ответственность у терминалов ниже: прерывание перезапишет своей версией, а
    // успех/провал/отмена чекпойнта не оставляют (инвариант волны C: «доделай» после честного
    // терминала не должно воскрешать задачу). clearIf по taskId — чужой слот не трогаем.
    // ⚠️ БЕЗУСЛОВНО, не по флагу (контроль-ревью волны E): при провале flush save() возвращает false
    // (флаг не взводился), но снимок ОСТАВАЛСЯ в ОЗУ-сторе — успешный терминал его не гасил, и
    // «доделай» 30 минут воскрешал СДЕЛАННУЮ задачу. clearIf по чужому/пустому слоту — no-op.
    deps.checkpoints?.clearIf(deps.userId, taskId);
    // W2: сессия модели этой задачи больше не нужна (подписка держит CLI-процесс и ждёт результат инструмента).
    deps.llm.release?.(taskId);
  }
  const outcome = computeOutcome(ctx);
  await finalizeTask(ctx, outcome);
  // T-F7: все попытки действия провалились, а модель честно это сказала — терминал успеха озвучит её фразу как
  // есть, но в реестре задача обязана быть провалом (finish на терминальной задаче — no-op).
  if (outcome.allMutationsFailed) tasks.fail(taskId, "ни одна попытка действия не удалась");
  return selectTerminal(ctx, outcome);
}

/**
 * tier0: локальный интент как одно действие round-trip (§5). arbiter задан (фоновый
 * путь) → берём/освобождаем аренду ввода сами; без него (инлайн) — аренда уже у
 * вызывающего (§20).
 */
async function runLocalIntent(
  session: Session,
  intent: LocalIntent,
  arbiter?: AsyncMutex,
  isClosed?: () => boolean,
  openOrFocus?: (url: string) => Promise<unknown>,
  /** Контроль-10: идёт ли фаза рисования вуали — ветка расширения клиентского гейта не проходит. */
  veilDrawing?: () => boolean,
): Promise<Tier0Reply> {
  if (arbiter) await arbiter.acquire();
  try {
    // Сессия закрылась, ПОКА ждали аренду (фоновая tier0-команда §20) — НЕ крадём фокус
    // мёртвой сессии (открытие приложения/сайта на уже ушедшем пользователе). Пустой voice
    // → startBackgroundTask его не озвучивает.
    if (isClosed?.()) return { voice: "" };
    // «Просто открой/включи» (inDefault): через расширение в ТВОЙ браузер С УЧЁТОМ открытых
    // вкладок — есть вкладка сервиса → ФОКУС (не дубль), нет → новая. Не трогает мышь (chrome.tabs).
    // Расширение не подключено / ошибка → откат на обычный путь (shell-open в дефолтный браузер).
    if (intent.kind === "browser.open" && intent.inDefault && openOrFocus) {
      // Контроль-10 (tier0-openorfocus-no-veil-gate): фикс контроля-9 закрыл ветку расширения у `browser_open`
      // (инструмент), но ОСНОВНОЙ путь «Джарвис, открой ютуб» — вот этот tier0, и он до модели не доходит вовсе.
      // `openOrFocus` поднимает окно Chrome поверх окна рисования и забирает у владельца Esc.
      if (veilDrawing?.()) {
        return { voice: verbalize(failurePhrase(intent, "overlay_drawing")), fallbackToLlm: true };
      }
      try {
        const r = (await openOrFocus(intent.url)) as { focused?: boolean } | undefined;
        return { voice: verbalize(r?.focused ? "Уже было открыто — переключился." : "Открыл.") };
      } catch (e) {
        log.info("расширение не открыло вкладку — откат на shell-open", { err: e instanceof Error ? e.message : String(e) });
      }
    }
    const command = intentToCommand(intent);
    const result = await session.sendAction(command, actionTimeoutMs(command.kind));
    void insertActionLog(buildActionLogEntry(session.sessionId, result.commandId, command, result));
    if (result.ok) {
      // §режим выделения: «сними выделение» без нашей рамки — почти наверняка про ПРИЛОЖЕНИЕ (Photoshop
      // Ctrl+D, граница таблицы в Word): tier0 это не его дело → отдаём модели, а не «снимать было нечего».
      if (intent.kind === "selection" && intent.op === "clear") {
        const d = (result.data as { cleared?: boolean; drawCancelled?: boolean } | undefined) ?? {};
        if (!d.cleared && !d.drawCancelled) return { voice: verbalize(successPhrase(intent, result.data)), fallbackToLlm: true };
      }
      return { voice: verbalize(successPhrase(intent, result.data)) };
    }
    log.warn("локальное действие не удалось", { kind: command.kind, code: result.error?.code, message: result.error?.message });
    // T-F5: фраза без модели НАЗЫВАЕТ причину («программа запустилась и сразу закрылась»), а не «не получилось».
    const voice = verbalize(tier0FailureVoice(intent, result.error?.code, result.error?.message));
    // Провал ЗАПУСКА любого кода — не приговор: «не нашёл» = имя не exe («тесты» → code_run, «стрим» → obs_request),
    // «запустилось и закрылось» = ярлык без аргументов (Discord Update.exe без --processStart, T-F5). Модель
    // получает причину врезкой; голос оставляем — потребители без отката озвучат честный провал.
    if (intent.kind === "app.launch") return { voice, fallbackToLlm: true, fallbackNote: tier0FallbackNote(intent, result.error?.code, result.error?.message) };
    // Контроль-8 (tier0-overlay-reason): вуаль — ВРЕМЕННОЕ состояние системы. Отдаём ход модели: она может дождаться
    // закрытия оверлея и довести дело, вместо того чтобы владелец повторял команду и слышал один и тот же отказ.
    if (result.error?.code === "overlay_drawing") return { voice, fallbackToLlm: true };
    return { voice };
  } finally {
    if (arbiter) arbiter.release();
  }
}

function intentToCommand(intent: LocalIntent): ActionCommand {
  switch (intent.kind) {
    case "app.launch":
      return { kind: "app.launch", app: intent.app };
    case "app.focus":
      return { kind: "app.focus", app: intent.app };
    case "browser.open":
      return { kind: "browser.open", url: intent.url, ...(intent.inDefault ? { inDefault: true } : {}) };
    case "media":
      return { kind: "system.media", op: intent.op };
    case "volume":
      return { kind: "system.volume", op: intent.op, ...(intent.level !== undefined ? { level: intent.level } : {}) };
    case "selection":
      // §режим выделения: оверлей открывается СРАЗУ (без waitMs) — ack звучит мгновенно, а обведённая
      // область приедет отдельным сообщением client.selection и попадёт в контекст следующего хода.
      // force: голосовая команда — явная воля владельца: start перерисовывает только что обведённое, clear
      // закрывает вуаль ЕГО рукой (клиент докладывает «владелец закрыл», а не «прервано не владельцем»).
      return { kind: "screen.selection", op: intent.op, force: true };
    case "clarify":
      throw new Error("clarify не превращается в ActionCommand (обрабатывается в handleUserText)");
  }
}
