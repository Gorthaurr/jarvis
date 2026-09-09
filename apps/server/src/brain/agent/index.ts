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
import { type AsyncMutex, type Tier, envInt, foldText } from "@jarvis/shared";
import { cleanDisfluency } from "../nlu/disfluency.js";
import { buildActionLogEntry, insertActionLog } from "../../db/action-log.js";
import type { Session } from "../../gateway/session.js";
import { type TaskCheckpoint, classifyResumeRequest, resumeOfferWindowMs } from "./checkpoint.js";
import { cosine } from "../../memory/episodic.js";
import { hasStableFactMarker, reflectFactFromUtterance } from "./memory-reflect.js";
import type { IEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { polarityConflict } from "../../memory/intent-polarity.js";
import { setDisplayName, setEmotion, setMode } from "../profile.js";
import { getMode, matchModeCommand } from "../persona/modes.js";
import { emotionName, matchEmotionCommand } from "../persona/emotion.js";
import { looksLikeCommandUtterance } from "./replay-gate.js";
import { hasCommitmentMarker, reflectCommitmentFromUtterance } from "./commitment-reflect.js";
import { type LocalIntent, classifyTier, isNotForMe, matchMediaIntent, resolveClarifyAnswer, stripWakeAndFiller } from "../router/index.js";
import { failurePhrase, successPhrase } from "../verbalize/action-phrases.js";
import { verbalize } from "../verbalize/index.js";
import { TaskManager } from "../tasks/manager.js";
import { classifyTaskScope, isDuplicateGoal, looksLikeDoneEcho, looksLikeStatusQuery } from "../tasks/scope.js";
import { type Task } from "../tasks/task.js";
import { createLoopState } from "./loop/state.js";
import { log, CHARS_PER_TOKEN, estimateResultTokens, replayUnsafe, withTimeout, waitWhilePaused, waitForChannel, markCacheBreakpoint } from "./loop/util.js";
import type { AgentReply, ReplySink, AgentDeps } from "./types.js";
import { loadLoopConfig } from "./loop/config.js";
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


/** «Зови меня X / меня зовут X / обращайся ко мне X» → имя (детерминированно, без LLM). */
const NAME_RE =
  /(?:обращайся ко мне|зови меня|называй меня|меня зовут|мо[её] имя)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,19})/iu;
function extractName(text: string): string | null {
  const m = NAME_RE.exec(text);
  if (!m?.[1]) return null;
  const raw = m[1].replace(/[.!?,]+$/u, "");
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Порог семантического дубля §20. Откалиброван ЖИВЫМ замером e5 (2026-07-10, sim-check):
 * истинные фрагмент-дубли — 0.863–0.933 («в доте»⟷research-цель 0.863, «в dot'е.»⟷цель эпизода
 * 0.911); ложные пары того же домена — 0.886–0.949 («напиши кате что опоздаю»⟷«…что приду вовремя»
 * 0.949!). Разделения НЕТ → слой применяется ТОЛЬКО к коротким фрагментам (см. findSemanticDuplicate),
 * где ложная пара не несёт нового содержания, с порогом 0.86 (ниже минимума истинных).
 */
function dupSemanticMin(): number {
  const n = Number.parseFloat(process.env.JARVIS_DUP_SEMANTIC_MIN ?? "");
  return Number.isFinite(n) && n >= 0.5 && n <= 1 ? n : 0.86;
}

/** Фрагмент ли реплика (≤3 токенов) — только такие пускаем в семантический дубль-слой. */
const DUP_FRAGMENT_MAX_TOKENS = 3;

// OUTBOUND_SEND_TOOLS переехал в error-voice.ts: тем же знанием пользуется журнал чекпойнта (волна C).

/** Окно пост-терминального гейта (мс): реплика-эхо/повтор в это окно после завершения задачи. 0 = выкл. */
function postTerminalGateMs(): number {
  const raw = Number(process.env.JARVIS_POST_TERMINAL_GATE_MS ?? 90_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 90_000;
}

/**
 * Семантический слой дубль-гейта §20 (Волна 1): реплика против целей ЖИВЫХ задач сессии (e5-косинус).
 * ТОЛЬКО для КОРОТКИХ фрагментов (≤3 токенов): живой замер показал, что e5-small НЕ разделяет
 * «другую команду в том же домене» от повтора (ложная пара 0.949 > истинных дублей) — а фраза
 * подлиннее может нести НОВОЕ содержание («напиши кате что ОПОЗДАЮ»), которое ложный «Уже делаю»
 * молча проглотит. Фрагмент же («в доте») нового содержания не несёт — цена ложного дубля мала.
 * Бюджет жёсткий (400мс на ВСЕ эмбеддинги — гейт стоит на пути приёмки команды); сбой/таймаут/null →
 * undefined (работает лексический слой, честная деградация). Полярность-гард (start↔stop) отсекает
 * противоположное намерение: «закрой доту» (sim 0.897!) не матчится дублем цели «запусти поиск».
 */
async function findSemanticDuplicate(
  embedder: IEmbeddingProvider,
  text: string,
  tasks: readonly Task[],
): Promise<Task | undefined> {
  if (tasks.length === 0) return undefined;
  const tokenCount = foldText(text).split(" ").filter(Boolean).length;
  if (tokenCount === 0 || tokenCount > DUP_FRAGMENT_MAX_TOKENS) return undefined;
  // Аудит 2026-07-28 (P0 «дубль-гейт ест реальные команды»): фрагмент с КОМАНДНЫМ глаголом — не
  // STT-эхо цели, а самостоятельный приказ. Живой случай: «напиши его.» (2 токена, sim 0.868 к
  // активной цели) съедался ложным «Уже делаю» — прямая потеря реплики. Слой рассчитан на
  // БЕЗГЛАГОЛЬНЫЕ обрывки («в доте»); команда уходит дальше по штатным гейтам — точный повтор
  // всё равно ловит лексический слой scope.isDuplicateGoal (стем-Жаккар/фрагмент-overlap).
  if (looksLikeCommandUtterance(text)) return undefined;
  try {
    // Все эмбеддинги ПАРАЛЛЕЛЬНО под ОДНИМ бюджетом (ревью 2026-07-10: последовательные await при
    // 3 задачах давали до 1.4с worst-case на пути приёмки каждой реплики). Сбой/таймаут одной цели
    // (null) не гасит проверку остальных. CachingEmbeddingProvider делает повторные цели ~бесплатными.
    const [qv, ...goals] = await withTimeout(
      Promise.all([
        embedder.embed(text, "query").catch(() => null),
        ...tasks.map((t) => embedder.embed(t.goal, "query").catch(() => null)),
      ]),
      400,
    );
    if (!qv) return undefined;
    let best: Task | undefined;
    let bestSim = 0;
    for (let i = 0; i < tasks.length; i += 1) {
      const gv = goals[i];
      if (!gv) continue;
      const sim = cosine(qv, gv);
      if (sim > bestSim) {
        bestSim = sim;
        best = tasks[i];
      }
    }
    if (best && bestSim >= dupSemanticMin()) {
      if (polarityConflict(text, best.goal)) {
        log.info("§20 семантический дубль подавлен полярность-гардом", { sim: Number(bestSim.toFixed(3)) });
        return undefined;
      }
      log.info("§20 дубль по семантике (e5)", { sim: Number(bestSim.toFixed(3)), goal: best.goal.slice(0, 60) });
      return best;
    }
  } catch {
    /* таймаут/сбой эмбеддера → решает лексический слой */
  }
  return undefined;
}

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
  meta?: { viaWake?: boolean; origin?: "watch-action" },
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

  // Память (§8/§11): пользователь представился → запоминаем имя НАВСЕГДА (профиль на диске),
  // подставляем в персону текущей сессии. Больше не спрашиваем при каждом запуске.
  const name = extractName(clean);
  if (name) {
    void setDisplayName(deps.userId, name);
    if (deps.userContext) deps.userContext.displayName = name;
    else deps.userContext = { displayName: name };
    const reply: AgentReply = { voice: verbalize(`Запомнил, ${name}. Рад знакомству.`) };
    deps.memory.pushTurn("assistant", reply.voice);
    return finishReply(reply);
  }

  // 🔴 «НЕ ТЕБЕ» — реплика адресована не Джарвису (лог 2026-09-02: владелец говорил с кем-то в
  // комнате, сказал «Нет, Джарвис, не тебе», а система завела фоновую sonnet-ЗАДАЧУ «Нет не тебе»
  // на 12 секунд и 563 токена; задача потом висела активной и путала scope соседних реплик).
  // Молчим НАМЕРЕННО: человека, который сказал «не тебе», ответом перебивать не надо. Активную
  // задачу не трогаем — это оговорка, а не «отмени».
  if (isNotForMe(clean)) {
    log.info("реплика адресована не Джарвису — молчим, задачу не заводим", { text: clean.slice(0, 60) });
    return finishReply({ voice: "" });
  }

  // Смена режима-маски (§11): «будь дерзким» / «будь собой» — детерминированно, без LLM.
  // Персист в профиль; тон применится со следующего хода (и голос переключится в пайплайне).
  const modeId = matchModeCommand(clean);
  if (modeId) {
    void setMode(deps.userId, modeId);
    const mode = getMode(modeId);
    const voice = verbalize(modeId === "butler" ? "Возвращаюсь к обычному тону, сэр." : `Готово — режим «${mode.name}».`);
    const reply: AgentReply = { voice };
    deps.memory.pushTurn("assistant", reply.voice);
    return finishReply(reply);
  }

  // Смена ЭМОЦИИ подачи (§21): «говори зло» / «скажи радостно» / «говори обычно» — детерминированно.
  // Персист в профиль (кеш обновляется СРАЗУ) → роль TTS и оверлей слов применяются уже к ЭТОМУ ходу.
  // neutral (сброс) подтверждаем коротко; на не-нейтральной НЕ возвращаемся — пусть LLM прямо сейчас
  // произнесёт реплику в новой подаче (демонстрация по просьбе «скажи что-нибудь по-злому»).
  const emotionCmd = matchEmotionCommand(clean);
  if (emotionCmd) {
    void setEmotion(deps.userId, emotionCmd);
    if (emotionCmd === "neutral") {
      const reply: AgentReply = { voice: verbalize("Возвращаюсь к обычному тону, сэр.") };
      deps.memory.pushTurn("assistant", reply.voice);
      return finishReply(reply);
    }
    log.info("§21 эмоция подачи установлена", { emotion: emotionName(emotionCmd) });
  }

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
  if (activeTask && !machineTurn) {
    log.info("§20 область реплики при активной задаче", {
      active: activeTask.title,
      scope: freshContext ? "new (свежий контекст)" : "edit (контекст текущей)",
    });
    // §20 ДУБЛЬ-ГЕЙТ — ПЕРВЫМ, до steer (Волна 1, эпизод 2026-07-10): повтор цели идущей задачи — не
    // «поправка» и не отдельное дело. ТОЛЬКО для scope=new: реплика с маркерами правки/реджекта
    // («нет, не то — запусти поиск в доте») — это рулёжка недовольного пользователя, ей ДОЛЖЕН
    // заниматься steer, а не «Уже делаю» (с фрагмент-overlap повтор цели в такой реплике матчится!).
    // Два слоя:
    //  1) лексический isDuplicateGoal (Жаккар + фрагмент-overlap + канонизация латиницы) — мгновенно;
    //  2) семантический бэкстоп (e5-косинус к целям активных задач) — ловит парафраз/STT-искажение,
    //     которое лексика не взяла. Порог консервативный (JARVIS_DUP_SEMANTIC_MIN, деф 0.9) +
    //     полярность-гард (start↔stop): «останови поиск» НИКОГДА не матчится дублем «запусти поиск».
    if (freshContext && deps.tasks) {
      // HIGH-3: живые задачи ПОЛЬЗОВАТЕЛЯ (не сессии) — дубль ловится и после reconnect.
      // §Волна2 (2.5): + queued — повтор команды, пока задача стоит в admission-очереди,
      // не должен плодить ВТОРУЮ queued-задачу (иначе смысл очереди теряется).
      const live = deps.tasks
        .list(deps.userId)
        .filter((t) => t.state === "running" || t.state === "paused" || t.state === "queued");
      let dup = live.find((t) => isDuplicateGoal(clean, t.goal));
      // Полярность-гард и на ЛЕКСИЧЕСКОМ слое (ревью 2026-07-10): «останови запуск поиска в доте»
      // лексически перекрывается с целью «запусти поиск в доте», но это команда ОСТАНОВКИ, не повтор.
      if (dup && polarityConflict(clean, dup.goal)) {
        log.info("§20 лексический дубль подавлен полярность-гардом", { goal: dup.goal.slice(0, 60) });
        dup = undefined;
      }
      if (!dup && deps.embedder) dup = await findSemanticDuplicate(deps.embedder, clean, live);
      if (dup) {
        log.info("§20 дубль активной задачи — вторую петлю не плодим", { taskId: dup.taskId, active: dup.title });
        const reply: AgentReply = { voice: verbalize("Уже делаю, сэр.") };
        deps.memory.pushTurn("assistant", reply.voice);
        return finishReply(reply);
      }
    }
    // §20 ПРАВКА НА ХОДУ: реплика-ПРАВКА («нет, не то» / «добавь ещё» / «переделай») во время активной
    // задачи — НЕ плодим вторую петлю и НЕ ждём её конца. Впрыскиваем в ИДУЩУЮ задачу (task.steer) —
    // петля подхватит перед ближайшим шагом — и сразу коротко подтверждаем. «new»-реплика (отдельное
    // дело) идёт прежним путём, самостоятельной параллельной задачей.
    if (!freshContext && deps.tasks?.steer(activeTask.taskId, clean)) {
      // Претензия/статус-запрос («ты не сделал», «я не вижу, что делаешь») — НЕ инструкция-правка: steer
      // впрыснут (петля перепроверит), но отвечаем ЧЕСТНЫМ СТАТУСОМ, а не «Принял, поправляю» — для
      // задачи-ожидания править нечего, и «поправляю» вводило в заблуждение. Инструкция-правка
      // («добавь/переделай/вместо») — прежнее «Принял, поправляю».
      const statusQuery = looksLikeStatusQuery(clean);
      log.info("§20 правка впрыснута в активную задачу", { taskId: activeTask.taskId, active: activeTask.title, statusQuery });
      const reply: AgentReply = {
        voice: statusQuery ? "Ещё занимаюсь этим, сэр — перепроверю и доложу, как будет готово." : "Принял, поправляю.",
      };
      deps.memory.pushTurn("assistant", reply.voice);
      return finishReply(reply);
    }
  }

  // Рефлекс-бэкстоп памяти (ревью 2026-07-10, А3): реплика с маркером УСТОЙЧИВОГО факта («я всегда…»,
  // «мой брат…», «у меня аллергия…») → фоновая рефлексия на дешёвом тире (fire-and-forget, ход не
  // ждёт). Диагноз: facts:0 за 15 дней — сама модель memory_write не звала; это зеркало самообучения
  // навыков, но для фактов о владельце. Кап/дедуп/выключатель — внутри модуля.
  if (hasStableFactMarker(clean)) {
    void reflectFactFromUtterance({
      llm: deps.llm,
      model: deps.models.sonnet,
      episodic: deps.episodic,
      userId: deps.userId,
      utterance: clean,
      spend: deps.spend, // §14: фоновый вызов виден гварду трат
    });
  }

  // Волна D «мажордом»: реплика-ОБЯЗАТЕЛЬСТВО со сроком («завтра надо позвонить маме») → фоновая
  // экстракция и напоминание САМО. Раньше владелец был обязан отдельно диктовать команду. Машинный
  // реэнтри (watch-action) сюда не идёт — это не речь владельца. Джарвис ОБЯЗАН сказать, что взял
  // дело на себя (onCreated → очередь озвучки), молчаливых будильников не ставим.
  if (!machineTurn && deps.reminders && hasCommitmentMarker(clean)) {
    void reflectCommitmentFromUtterance({
      llm: deps.llm,
      model: deps.models.sonnet,
      reminders: deps.reminders,
      sessionId: session.sessionId,
      userId: deps.userId,
      utterance: clean,
      spend: deps.spend,
      // verbalize — как у всех проактивных каналов (числа словами, латиница в фонетику): без него
      // «Поставил напоминание через 20 ч» звучало бы сырой строкой (ревью волны D).
      onCreated: (line) => deps.speakResult?.({ voice: verbalize(line) }, { origin: "proactive" }), // W0: рефлекс — проактив
    });
  }

  // Консьерж (§): висит уточнение → пробуем реплику как ОТВЕТ на него (мгновенно, без LLM).
  // Одноразово: подошло — действуем; не подошло (сменил тему) — снимаем и маршрутизируем обычно.
  // Машинный реэнтри (watch-action) уточнение НЕ трогает — оно ждёт настоящего ответа владельца.
  if (deps.pendingClarify && !machineTurn) {
    const pend = deps.pendingClarify;
    deps.pendingClarify = undefined;
    const resolved = resolveClarifyAnswer(pend.key, clean);
    if (resolved) {
      // Контроль-9 (clarify-path-ignores-fallback): исход tier0 использовался КАК ЕСТЬ, в отличие от основной ветки
      // ниже. Под открытой вуалью (или когда приложение не нашлось) `browser.open`/`app.launch` отдают
      // `fallbackToLlm`, и ход модели, ради которого откат вводился, не отдавался ВООБЩЕ: довести дело после
      // закрытия рамки было некому, а сказанное владельцу не попадало в рабочую память (sync-first ветка её
      // сознательно не пишет — «ассистентской реплики ещё нет»).
      const t0c = await runTier0(session, resolved, deps, sink); // sink → консьерж-открытие тоже sync-first
      if (!t0c.fallbackToLlm) return finishReply(t0c);
      log.info("tier0: ответ на уточнение не закрыт детерминированно — передаю модели", { key: pend.key });
    }
  }

  // §20 ПОСТ-ТЕРМИНАЛЬНЫЙ ЭХО-ГЕЙТ (эпизод «двойная отправка Кате» 2026-07-24): пользователь
  // договаривает мысль, пока задача летит — обрывок («Это написал.») эндпоинтится через СЕКУНДУ ПОСЛЕ
  // терминала. Активной задачи уже нет → гейты §20 слепы → вторая петля, и модель ПОВТОРЯЕТ действие.
  // Здесь перехватывается ТОЛЬКО короткое эхо-подтверждение/статус без содержательных токенов
  // («Это написал.», «готово?») → честный статус-ответ, не петля. ⚠️ Лексический дубль-гейт по цели
  // («повтор» → «Уже отправил») здесь СОЗНАТЕЛЬНО НЕ СТОИТ (контрольное ревью, 2 HIGH): лексика не
  // отличает повтор от ПОПРАВКИ («…что я НЕ приду») или ДРУГОГО адресата («…маме») — молчаливый
  // перехват глотал бы реальный приказ с ложным «Уже отправил». Повтор цели уходит МОДЕЛИ: дубль по
  // содержанию встретит ресенд-гард messaging-слоя (identical → «повтор не ушёл», similar → confirm).
  // hasAnyActive (вкл. скрытые разговорные и при выключенном scope): при ЛЮБОЙ живой задаче гейт молчит —
  // реплика может относиться к ней, пусть решают штатные пути §20/модель.
  const postTermMs = postTerminalGateMs();
  if (!activeTask && postTermMs > 0 && deps.tasks && !deps.tasks.hasAnyActive(deps.userId)) {
    const nowMs = Date.now();
    const recentTerm = deps.tasks.recentTerminal(deps.userId, { limit: 3, maxAgeMs: postTermMs, now: nowMs });
    // Эхо-статус — ТОЛЬКО при ЕДИНСТВЕННОМ свежем терминале, и он успешен (ревью: при двух свежих
    // задачах «отправил?» мог получить итог НЕ ТОЙ — новейшей — задачи; после провала «готово?»
    // обязан получить честный разбор моделью, а не «сделал» от более старой done-задачи).
    const newest = recentTerm[0];
    if (recentTerm.length === 1 && newest?.state === "done" && looksLikeDoneEcho(clean)) {
      log.info("§20 пост-терминальный гейт: эхо-статус после завершения — отвечаю статусом, не петлёй", {
        taskId: newest.taskId, title: newest.title, text: clean.slice(0, 60),
      });
      const reply: AgentReply = { voice: verbalize(newest.resultSummary || `Сделал, сэр — ${newest.title}.`) };
      deps.memory.pushTurn("assistant", reply.voice);
      return finishReply(reply);
    }
  }

  // Волна C (P0 #4): «ПРОДОЛЖИ» ПОСЛЕ ПРЕРВАННОЙ ЗАДАЧИ — продолжаем по-настоящему.
  // Раньше терминал предлагал «Продолжить с того же места?», а «продолжи» запускало ХОЛОДНУЮ петлю
  // с нуля (весь наработанный контекст выброшен) — обещание было ложным.
  // Гарды: (а) только ГОЛАЯ команда продолжения (isResumeRequest — позитивный allowlist: «продолжи
  // видео» сюда НЕ попадёт и уйдёт в tier0-медиа); (б) только при ЖИВОМ чекпойнте (нет/протух →
  // не перехватываем вовсе, прежний путь без регресса); (в) не при активной задаче (там своя
  // pause/resume-механика §20 в task-control); (г) не для машинного реэнтри (watch-action).
  // Нормализация — ТА ЖЕ, что у роутера (ревью: своя копия расходилась — «давай продолжи» роутер
  // считал медиа-командой, а гард продолжения не считал, и гард молча не срабатывал).
  const resumeText = stripWakeAndFiller(clean);
  const resumeKind = classifyResumeRequest(resumeText);
  // Гейт по ВИДИМЫМ задачам (activeForUser), а не hasAnyActive (финальный контроль волны C): скрытая
  // РАЗГОВОРНАЯ задача (Б6) глушила перехват, а §20-control её тоже не видит — обещанное «доделай»
  // падало в ХОЛОДНУЮ петлю мимо журнала. Видимая задача по-прежнему уводит фразу в pause/resume §20.
  if (!machineTurn && deps.checkpoints && (deps.tasks?.activeForUser(deps.userId).length ?? 0) === 0 && resumeKind.isResume) {
    const pending = deps.checkpoints.peek(deps.userId);
    // ⚠️ КОЛЛИЗИЯ С ПЛЕЕРОМ: голое «продолжи»/«продолжай»/«возобнови» — это ЕЩЁ И tier0-команда
    // «сними видео с паузы» (router MEDIA_PATTERNS). Красть её у плеера можно только тогда, когда мы
    // САМИ только что предложили продолжить: свежий чекпойнт (окно предложения). Позже владелец с
    // куда большей вероятностью говорит плееру — отдаём фразу прежнему пути (чекпойнт не трогаем,
    // он дождётся ОДНОЗНАЧНОЙ формы — именно её и называет терминал: «скажите „доделай"»).
    // Источник истины про медиа — сам роутер, не вторая копия списка слов.
    // Омонимичность плееру считается по САМОЙ ФОРМЕ, а не по якорному матчеру роутера: одного
    // вежливого слова («теперь продолжай») хватало, чтобы матчер промолчал и гард отключился —
    // старая задача поднималась все 30 минут TTL (контрольное ревью-2).
    const claimedByMedia = resumeKind.ambiguousWithMedia || Boolean(matchMediaIntent(resumeText));
    // Окно считается от ФАКТА ПРЕДЛОЖЕНИЯ, не от сохранения: молча сохранённый чекпойнт (сбой записи
    // на диск, обновление журнала после провала) у плеера ничего не отбирает.
    const offerFresh = pending?.offeredAt !== undefined && Date.now() - pending.offeredAt <= resumeOfferWindowMs();
    if (pending && claimedByMedia && !offerFresh) {
      log.info("§волна C: голое «продолжи» вне окна предложения — отдаю плееру, чекпойнт не трогаю", {
        taskId: pending.taskId,
        ageMs: Date.now() - pending.savedAt,
      });
    }
    // ⚠️ НЕ take(): чекпойнт потребляется деструктивно только при УСПЕХЕ продолжения (см. терминал).
    // Ревью (HIGH): take() до старта уничтожал журнал 18-раундовой работы, если возобновлённая петля
    // падала на первом же ответе (аварийный стаб LLM/занятый ввод/spend-cap) — там saveCheckpoint не
    // зовётся (или round=0), и владелец терял ВСЁ, услышав «Повторите, пожалуйста». Вторую петлю
    // одновременно не поднять: гейт выше требует отсутствия активной задачи.
    const cp = pending && (!claimedByMedia || offerFresh) ? pending : null;
    if (cp) {
      log.info("§волна C: перехват «продолжи» — поднимаю чекпойнт прерванной задачи", {
        taskId: cp.taskId,
        title: cp.title,
        reason: cp.reason,
        ageMs: Date.now() - cp.savedAt,
      });
      // §15: возвращаем арсенал холодных инструментов прошлого захода — иначе продолжение начинает
      // с потерянными tool_load'ами и тратит раунды на их повторную загрузку.
      if (deps.toolActivation && cp.toolNames) for (const n of cp.toolNames) deps.toolActivation.add(n);
      const resumeOpts = { resumeFrom: cp, viaWake: meta?.viaWake };
      if (deps.speakResult) {
        if (sink && process.env.JARVIS_SYNC_FIRST !== "0") {
          return await runActionSyncFirst(session, cp.goal, cp.tier, deps, sink, resumeOpts);
        }
        deps.taskAccepted?.();
        startBackgroundTask(() => runAgentLoop(session, cp.goal, cp.tier, deps, undefined, resumeOpts), deps, { bounded: true });
        return finishReply({ voice: "" });
      }
      const reply = await runAgentLoop(session, cp.goal, cp.tier, deps, sink, resumeOpts);
      deps.memory.pushTurn("assistant", reply.voice);
      return finishReply(reply);
    }
  }

  const decision = classifyTier(clean);
  log.info("маршрутизация", { tier: decision.tier, reason: decision.reason });
  let tier0FellBack = false;

  // tier0 (запуск/фокус/сайт) — детерминированно, без LLM. Под арендой ввода (§20):
  // свободна → инлайн (мгновенно), занята фоновой задачей → не крадём фокус.
  if (decision.tier === "tier0" && decision.local) {
    // Консьерж: голая команда-сервис → мгновенный короткий вопрос + ждём ответ (НЕ действие).
    if (decision.local.kind === "clarify") {
      deps.memory.pushTurn("assistant", decision.local.question);
      deps.pendingClarify = { key: decision.local.key };
      return finishReply({ voice: decision.local.question });
    }
    const t0 = await runTier0(session, decision.local, deps, sink);
    if (!t0.fallbackToLlm) return finishReply(t0);
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
  if (deps.responseCache && decision.conversational === true && !selectionAtStart) {
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
      // ГОЛОСОВОЙ канал: sync-first с промоушеном в фон — итог звучит СРАЗУ, длинная задача через 10с
      // говорит «Берусь» и уходит в фон (микрофон свободен). Это и есть фикс «молча → скопом».
      return await runActionSyncFirst(session, clean, tier, deps, sink, { freshContext, viaWake: meta?.viaWake, machine: machineTurn });
    }
    // Без sink (dev.text/чат/тесты) ИЛИ откат JARVIS_SYNC_FIRST=0: прежнее — молча в фон, итог через
    // speakResult (в тексте нет аудио-очереди → скопом не сливается; сеанс не блокируется на длинной задаче).
    deps.taskAccepted?.();
    const preTask = queuedPreTask(session, clean, deps);
    startBackgroundTask(() => runAgentLoop(session, clean, tier, deps, undefined, { freshContext, viaWake: meta?.viaWake, machine: machineTurn, selectionAtStart, preTask }), deps, { bounded: true, preTask });
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
    selectionAtStart,
    smalltalk: decision.smalltalk === true,
    viaWake: meta?.viaWake,
    machine: machineTurn,
  });
  deps.memory.pushTurn("assistant", reply.voice);
  return finishReply(reply);
}

/**
 * tier0 «открой/запусти/переключись X» (§7). Команда трогает фокус/окно → идёт под
 * арендой ввода (§20). Аренда свободна (или её нет — тесты) → инлайн, мгновенный отзыв.
 * Занята фоновой задачей → не крадём фокус и не блокируем разговор: подтверждаем
 * по-дворецки и исполняем фоновой микро-задачей, когда аренда освободится. Без
 * асинхронного канала — честно ждём аренду и исполняем инлайн (корректность > задержки).
 */
async function runTier0(session: Session, local: LocalIntent, deps: AgentDeps, sink?: ReplySink): Promise<AgentReply> {
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
    const promoteMs = envInt("JARVIS_SYNC_PROMOTE_MS", SYNC_PROMOTE_DEFAULT_MS);
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
  const task = deps.tasks.create({ userId: deps.userId, sessionId: session.sessionId, goal });
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
 * Действие идёт СИНХРОННО с sink (первый звук — как только готово), НО если не уложилось в бюджет
 * JARVIS_SYNC_PROMOTE_MS — ПРОМОТИМ в фон: финализируем ход одной фразой «Берусь, сэр» (микрофон
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
  opts: { freshContext?: boolean; viaWake?: boolean; resumeFrom?: TaskCheckpoint; machine?: boolean },
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

  const promoteMs = envInt("JARVIS_SYNC_PROMOTE_MS", SYNC_PROMOTE_DEFAULT_MS);
  let detached = false;
  // Обёртка: до промоушена — прозрачна к реальному sink; после — инертна (петля больше не стримит
  // в голосовой канал; её финал доставит speakResult). Петля зовёт только sentence/thinking (см.
  // контракт: sink.done делает ВЫЗЫВАЮЩИЙ, не петля), поэтому done тут не нужен.
  const wrap: ReplySink = {
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
  };
  // suppressStepStream (фикс double-speak): action-петля НЕ стримит step-0 пофразно в sink → нет pushedAny
  // в пайплайне ДО промоушена → «Берусь» не глохнет и итог не звучит вторым разом. Финал — один раз
  // (терминал при done / speakResult при промоушене). Разговорный путь (conversational) стрим сохраняет.
  const loopP = runAgentLoop(session, text, tier, deps, wrap, { ...opts, conversational: false, suppressStepStream: true });
  void loopP.then(release, release); // слот держим на ВСЮ жизнь петли (sync + промоушен), освобождаем на терминации
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race<{ kind: "done"; reply: AgentReply } | { kind: "error"; error: unknown } | { kind: "slow" }>([
    // onRejected обязателен: без него отклонение петли ПОСЛЕ выигрыша таймера (промоушен) стало бы
    // unhandled rejection (петля ещё в полёте). До промоушена ошибка пробрасывается наверх (как в
    // синхронном пути), после — её ловит bg.catch ниже.
    loopP.then((reply) => ({ kind: "done" as const, reply }), (error) => ({ kind: "error" as const, error })),
    new Promise<{ kind: "slow" }>((res) => {
      timer = setTimeout(() => res({ kind: "slow" }), promoteMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);

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

  // ПРОМОУШЕН: задача затянулась → «Берусь, сэр» СРАЗУ (не молчание), микрофон освобождается, итог в фон.
  detached = true;
  log.info("sync-first: задача затянулась — промоушен в фон", { promoteMs });
  sink.done(verbalize(promoteAck()));
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
 * W0 (2026-09-09): ПРОМОУШЕН В ФОН ЧЕРЕЗ 1,5 с, а не через 10. Телеметрия за 30 дней: 41 из 86 замеров
 * mouth-to-ear легли ровно в 10 013–10 525 мс — первым звуком любого хода с инструментами был «Берусь, сэр»
 * на 10-й секунде, а до него только earcon-тик на 700 мс. То есть Джарвис был СПРОЕКТИРОВАН отвечать
 * через 10 секунд. Теперь первый звук — через ~1,5 с (короткие задачи по-прежнему отвечают результатом
 * сразу: они укладываются в бюджет). Env JARVIS_SYNC_PROMOTE_MS переопределяет.
 */
const SYNC_PROMOTE_DEFAULT_MS = 1_500;
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
  opts?: LoopOpts,
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
  const task = opts?.preTask ?? tasks.create({ userId: deps.userId, sessionId: session.sessionId, goal: text, conversational: isConversational });
  if (opts?.preTask) tasks.start(task.taskId);
  const taskId = task.taskId;

  const cfg = loadLoopConfig(isConversational);
  const ctx = await buildLoopContext({ session, text, tier, deps, sink, opts, st, task, taskId, tasks, isConversational, cfg });
  const { arbiter } = ctx;
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
): Promise<AgentReply> {
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
    log.warn("локальное действие не удалось", { kind: command.kind, code: result.error?.code });
    const voice = verbalize(failurePhrase(intent, result.error?.code));
    // Не нашёл ПРИЛОЖЕНИЕ по имени — это не приговор, а сигнал «имя не exe»: модель разберёт («тесты» →
    // code_run vitest, «стрим» → obs_request). Голос оставляем — потребители без отката озвучат честный провал.
    if (intent.kind === "app.launch" && result.error?.code === "not_found") return { voice, fallbackToLlm: true };
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
