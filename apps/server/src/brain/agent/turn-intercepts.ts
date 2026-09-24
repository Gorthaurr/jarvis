// W3 «Петля»: детерминированные перехваты хода ДО маршрутизации в модель — список в порядке прежней
// if-цепочки handleUserText (имя, «не тебе», режим, эмоция, активная задача, рефлексы, уточнение консьержа,
// эхо-гейт, продолжение прерванной задачи). Каждый: вернул ответ → ход закрыт, null → следующий.
import { log, withTimeout } from "./loop/util.js";
import type { AgentDeps, AgentReply, ReplySink, LoopOpts } from "./types.js";
import type { Task } from "../tasks/task.js";
import { type LocalIntent, isNotForMe, matchMediaIntent, resolveClarifyAnswer, stripWakeAndFiller } from "../router/index.js";
import { type Tier, foldText } from "@jarvis/shared";
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
import { verbalize } from "../verbalize/index.js";
import { isDuplicateGoal, looksLikeDoneEcho, looksLikeStatusQuery } from "../tasks/scope.js";

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

/** Метаданные хода от голосового пайплайна (см. handleUserText). */
export interface TurnMeta { viaWake?: boolean; origin?: "watch-action" }
/** Исполнители, которые живут в agent/index.ts (петля, sync-first, фон) — перехваты зовут их через контекст, без цикла импортов. */
export interface TurnRunners {
  runTier0: (session: Session, local: LocalIntent, deps: AgentDeps, sink?: ReplySink) => Promise<AgentReply>;
  runAgentLoop: (session: Session, text: string, tier: Exclude<Tier, "tier0">, deps: AgentDeps, sink?: ReplySink, opts?: LoopOpts) => Promise<AgentReply>;
  runActionSyncFirst: (session: Session, text: string, tier: Exclude<Tier, "tier0">, deps: AgentDeps, sink: ReplySink, opts: { freshContext?: boolean; viaWake?: boolean; resumeFrom?: TaskCheckpoint; machine?: boolean }) => Promise<AgentReply>;
  startBackgroundTask: (run: () => Promise<AgentReply>, deps: AgentDeps, opts: { bounded: boolean; preTask?: Task }) => void;
}
export interface TurnCtx {
  session: Session;
  deps: AgentDeps;
  sink: ReplySink | undefined;
  meta: TurnMeta | undefined;
  /** Сырая реплика и причёсанная (cleanDisfluency). */
  text: string;
  clean: string;
  finishReply: (reply: AgentReply) => AgentReply;
  machineTurn: boolean;
  activeTask: Task | undefined;
  freshContext: boolean;
  run: TurnRunners;
}
export type TurnIntercept = (t: TurnCtx) => Promise<AgentReply | null> | AgentReply | null;

export function interceptName(t: TurnCtx): AgentReply | null {
  const { deps, clean, finishReply } = t;
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
  return null;
}

export function interceptNotForMe(t: TurnCtx): AgentReply | null {
  const { text, clean, finishReply } = t;
  // 🔴 «НЕ ТЕБЕ» — реплика адресована не Джарвису (лог 2026-09-02: владелец говорил с кем-то в
  // комнате, сказал «Нет, Джарвис, не тебе», а система завела фоновую sonnet-ЗАДАЧУ «Нет не тебе»
  // на 12 секунд и 563 токена; задача потом висела активной и путала scope соседних реплик).
  // Молчим НАМЕРЕННО: человека, который сказал «не тебе», ответом перебивать не надо. Активную
  // задачу не трогаем — это оговорка, а не «отмени».
  if (isNotForMe(clean)) {
    log.info("реплика адресована не Джарвису — молчим, задачу не заводим", { text: clean.slice(0, 60) });
    return finishReply({ voice: "" });
  }
  return null;
}

export function interceptMode(t: TurnCtx): AgentReply | null {
  const { deps, clean, finishReply } = t;
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
  return null;
}

export function interceptEmotion(t: TurnCtx): AgentReply | null {
  const { deps, clean, finishReply } = t;
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
  return null;
}

export async function interceptActiveTask(t: TurnCtx): Promise<AgentReply | null> {
  const { deps, clean, finishReply, machineTurn, activeTask, freshContext } = t;
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
  return null;
}

export function fireReflexes(t: TurnCtx): null {
  const { session, deps, clean, machineTurn } = t;
  // Рефлекс-бэкстоп памяти (ревью 2026-07-10, А3): реплика с маркером УСТОЙЧИВОГО факта («я всегда…»,
  // «мой брат…», «у меня аллергия…») → фоновая рефлексия на дешёвом тире (fire-and-forget, ход не
  // ждёт). Диагноз: facts:0 за 15 дней — сама модель memory_write не звала; это зеркало самообучения
  // навыков, но для фактов о владельце. Кап/дедуп/выключатель — внутри модуля.
  // T-F1: реплики dev-сессии (смоук агента) — не речь владельца: ни фактов о нём, ни напоминаний из них.
  if (deps.devSession) return null;
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
  return null;
}

export async function interceptClarify(t: TurnCtx): Promise<AgentReply | null> {
  const { session, deps, sink, clean, finishReply, machineTurn } = t;
  const { runTier0 } = t.run;
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
  return null;
}

export function interceptEchoGate(t: TurnCtx): AgentReply | null {
  const { deps, text, clean, finishReply, activeTask } = t;
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
  return null;
}

export async function interceptResume(t: TurnCtx): Promise<AgentReply | null> {
  const { session, deps, sink, meta, clean, finishReply, machineTurn } = t;
  const { runAgentLoop, runActionSyncFirst, startBackgroundTask } = t.run;
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
  return null;
}

/** Порядок = порядок прежней if-цепочки; первый ответивший перехват закрывает ход. */
export const TURN_INTERCEPTS: readonly TurnIntercept[] = [
  interceptName,
  interceptNotForMe,
  interceptMode,
  interceptEmotion,
  interceptActiveTask,
  fireReflexes,
  interceptClarify,
  interceptEchoGate,
  interceptResume,
];
