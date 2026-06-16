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
import type { ActionCommand, TaskStatus } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS, newId } from "@jarvis/protocol";
import { type AsyncMutex, type Logger, type Semaphore, type Tier, createLogger, sleep } from "@jarvis/shared";
import { TOOL_SCHEMAS } from "@jarvis/tools";
import { toolNeedsInput } from "../tools/input-kinds.js";
import { cleanDisfluency } from "../nlu/disfluency.js";
import { type ButlerAcks, DEFAULT_BUTLER_ACKS } from "../persona/acks.js";
import { buildActionLogEntry, insertActionLog } from "../../db/action-log.js";
import type { Session } from "../../gateway/session.js";
import type { ILlmProvider, LlmContentBlock, LlmMessage } from "../../integrations/llm.js";
import type { IWebProvider } from "../../integrations/web.js";
import type { EpisodicMemory } from "../../memory/episodic.js";
import type { WorkingMemory } from "../../memory/working.js";
import type { SpendGuard } from "../../billing/index.js";
import { type UserContextSlot, buildSystemPrompt } from "../persona/index.js";
import { getProfile, setDisplayName, setMode } from "../profile.js";
import { getMode, matchModeCommand } from "../persona/modes.js";
import { type LocalIntent, classifyTier } from "../router/index.js";
import { type ToolContext, dispatchTool } from "../tools/dispatch.js";
import type { DynamicToolStore } from "../tools/dynamic.js";
import type { RecalledSkill, SkillProvider } from "../../memory/skills.js";
import { verbalize } from "../verbalize/index.js";
import { TaskManager } from "../tasks/manager.js";
import type { Task } from "../tasks/task.js";
import { SessionWarmth } from "./warmth.js";

const log: Logger = createLogger("agent");

/** Тёплость сессий по умолчанию (§15), если не инъектирован общий через deps. */
const sharedWarmth = new SessionWarmth();

/** Ответ агента по схеме §21. */
export interface AgentReply {
  voice: string;
  display?: { title?: string; markdown: string };
}

/** Зависимости агента (инъекция для тестируемости и разделения слоёв). */
export interface AgentDeps {
  memory: WorkingMemory;
  llm: ILlmProvider;
  episodic: EpisodicMemory;
  web: IWebProvider;
  /** id моделей по тирам (§7). */
  models: Record<Exclude<Tier, "tier0">, string>;
  spend: SpendGuard;
  userId: string;
  userContext?: UserContextSlot;
  /**
   * Реестр долгих задач (§20). ОБЩИЙ с router-ws: команды «отмени»/«пауза» из UI
   * мутируют cancel-флаг той же задачи, которую держит петля. Опционален — если не
   * передан, петля заводит локальный реестр (для изолированных тестов).
   */
  tasks?: TaskManager;
  /** Тёплость сессий для §15-кеширования (общая с gateway); по умолчанию — модульная. */
  warmth?: SessionWarmth;
  /** Реестр самописных инструментов (§8+ саморасширение); общий с gateway. */
  dynamicTools?: DynamicToolStore;
  /** Провайдер выученных показом навыков (§8); общий с gateway. */
  skills?: SkillProvider;
  /** Отправка в Telegram через браузерное расширение (§6): невидимо, фоновой вкладкой. */
  telegramSend?: (to: string, text: string) => Promise<unknown>;
  /**
   * Канал озвучки РЕЗУЛЬТАТА фоновой задачи (§20 async). Если задан — многошаговые
   * задачи исполняются в фоне (не блокируя разговор), а итог проговаривается сюда.
   * Без него (тесты/dev.text) — синхронное поведение.
   */
  speakResult?: (reply: AgentReply) => void;
  /**
   * Аренда физического ввода на сессию (§20): команды, трогающие мышь/клаву/фокус
   * (вкл. tier0 «открой X»), сериализуются через неё, а независимые задачи бегут
   * параллельно. Опциональна: без неё (изолированные тесты) — без сериализации.
   */
  inputArbiter?: AsyncMutex;
  /** Ограничитель числа параллельных фоновых agent-loop'ов (§20). По умолч. — без лимита. */
  concurrency?: Semaphore;
  /** Реестр живых фоновых задач сессии (для дожидания/чистки на закрытии, §20). */
  bgTasks?: Set<Promise<void>>;
  /** Пул дворецких подтверждений голосом персоны (§11). Без него — зашитый seed. */
  acks?: ButlerAcks;
  /** Per-session счётчик ротации ack (мутируется агентом; не процесс-глобальный). */
  ackRotation?: number;
  /** Закрыта ли сессия (§20): фоновый итог не озвучиваем в мёртвую сессию. */
  isClosed?: () => boolean;
}

/** Инструменты, не предлагаемые модели в диалоге (инициируются иначе / не в концепции).
 *  demo_record — запись навыка стартует кнопкой «Сделать скилл» в UI, не моделью.
 *  message_send/order_place — это userbot/mock-API (реально не шлёт/не заказывает) и НЕ в
 *  концепции «тонкий клиент». Убраны, чтобы Джарвис не хватался за фейковый шорткат, а делал
 *  по-человечески через интерфейс: открыл мессенджер (web.telegram.org/приложение) → нашёл
 *  контакт → впечатал → отправил (browser_act, ui_invoke, input_type), как в персоне (§6, §8).
 *  skill_execute ПРЕДЛАГАЕТСЯ (§8): модель запускает выученные навыки по id. */
const EXCLUDED_TOOLS = new Set(["demo_record", "message_send", "order_place"]);

/** «Зови меня X / меня зовут X / обращайся ко мне X» → имя (детерминированно, без LLM). */
const NAME_RE =
  /(?:обращайся ко мне|зови меня|называй меня|меня зовут|мо[её] имя)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,19})/iu;
function extractName(text: string): string | null {
  const m = NAME_RE.exec(text);
  if (!m?.[1]) return null;
  const raw = m[1].replace(/[.!?,]+$/u, "");
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/** Промис под жёстким таймаутом: reject по истечении ms (для НЕОБЯЗАТЕЛЬНЫХ шагов §10). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    if (typeof t === "object" && "unref" in t) (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function handleUserText(
  session: Session,
  text: string,
  deps: AgentDeps,
): Promise<AgentReply> {
  // Причесать спонтанную речь (§10): убрать запинки/повторы/обрывки/«не X, а Y» — чтобы
  // оговорки понимались и в детерминированном tier0, и в LLM. Если чистка выела всё
  // (фраза была одной хезитацией) — оставляем оригинал, не теряем ход.
  const clean = cleanDisfluency(text.trim()) || text.trim();
  deps.memory.pushTurn("user", clean);

  // Память (§8/§11): пользователь представился → запоминаем имя НАВСЕГДА (профиль на диске),
  // подставляем в персону текущей сессии. Больше не спрашиваем при каждом запуске.
  const name = extractName(clean);
  if (name) {
    void setDisplayName(name);
    if (deps.userContext) deps.userContext.displayName = name;
    else deps.userContext = { displayName: name };
    const reply: AgentReply = { voice: verbalize(`Запомнил, ${name}. Рад знакомству.`) };
    deps.memory.pushTurn("assistant", reply.voice);
    return reply;
  }

  // Смена режима-маски (§11): «будь дерзким» / «будь собой» — детерминированно, без LLM.
  // Персист в профиль; тон применится со следующего хода (и голос переключится в пайплайне).
  const modeId = matchModeCommand(clean);
  if (modeId) {
    void setMode(modeId);
    const mode = getMode(modeId);
    const voice = verbalize(modeId === "butler" ? "Возвращаюсь к обычному тону, сэр." : `Готово — режим «${mode.name}».`);
    const reply: AgentReply = { voice };
    deps.memory.pushTurn("assistant", reply.voice);
    return reply;
  }

  // Фоновая запись реплики в эпизодическую память (контекст будущих сессий, §8).
  if (clean.length > 3) {
    void deps.episodic
      .write({ userId: deps.userId, kind: "event", text: clean, ts: Date.now() })
      .catch(() => undefined);
  }

  const decision = classifyTier(clean);
  log.info("маршрутизация", { tier: decision.tier, reason: decision.reason });

  // tier0 (запуск/фокус/сайт) — детерминированно, без LLM. Под арендой ввода (§20):
  // свободна → инлайн (мгновенно), занята фоновой задачей → не крадём фокус.
  if (decision.tier === "tier0" && decision.local) {
    return runTier0(session, decision.local, deps);
  }
  const tier: Exclude<Tier, "tier0"> = decision.tier === "tier0" ? "haiku" : decision.tier;

  // Многошаговая задача (sonnet/fable) + есть канал асинхронной озвучки → НЕ блокируем
  // разговор: по-дворецки подтверждаем СРАЗУ, работу гоним в фоне. Независимые задачи
  // бегут ПАРАЛЛЕЛЬНО (не серийной цепочкой); конкуренцию за мышь/клаву разруливает
  // аренда ввода (§20) внутри петли. Итог проговорим по готовности.
  if ((tier === "sonnet" || tier === "fable") && deps.speakResult) {
    startBackgroundTask(() => runAgentLoop(session, clean, tier, deps), deps, { bounded: true });
    return ackReply(deps);
  }

  // haiku-болтовня / нет асинхронного канала (тесты) → синхронно.
  const reply = await runAgentLoop(session, clean, tier, deps);
  deps.memory.pushTurn("assistant", reply.voice);
  return reply;
}

/**
 * tier0 «открой/запусти/переключись X» (§7). Команда трогает фокус/окно → идёт под
 * арендой ввода (§20). Аренда свободна (или её нет — тесты) → инлайн, мгновенный отзыв.
 * Занята фоновой задачей → не крадём фокус и не блокируем разговор: подтверждаем
 * по-дворецки и исполняем фоновой микро-задачей, когда аренда освободится. Без
 * асинхронного канала — честно ждём аренду и исполняем инлайн (корректность > задержки).
 */
async function runTier0(session: Session, local: LocalIntent, deps: AgentDeps): Promise<AgentReply> {
  const arbiter = deps.inputArbiter;
  if (!arbiter || arbiter.tryAcquire()) {
    try {
      const reply = await runLocalIntent(session, local);
      deps.memory.pushTurn("assistant", reply.voice);
      return reply;
    } finally {
      if (arbiter) arbiter.release();
    }
  }
  if (deps.speakResult) {
    startBackgroundTask(() => runLocalIntent(session, local, arbiter, deps.isClosed), deps, { bounded: false });
    return ackReply(deps);
  }
  await arbiter.acquire();
  try {
    const reply = await runLocalIntent(session, local);
    deps.memory.pushTurn("assistant", reply.voice);
    return reply;
  } finally {
    arbiter.release();
  }
}

/**
 * Дворецкое подтверждение (§11, §20). ВАЖНО: ack НЕ пишем в рабочую память — это филлер,
 * не контент диалога. Иначе фоновая задача читает память, заканчивающуюся на assistant-ack,
 * и строит convo, оканчивающийся ассистентом → Opus 4.8 отклоняет (400: «conversation must
 * end with a user message», без префилла). Реальный итог задачи попадёт в память по готовности.
 */
function ackReply(deps: AgentDeps): AgentReply {
  return { voice: verbalize(butlerAck(deps)) };
}

/**
 * Мгновенное дворецкое подтверждение «принял, делаю» (§11). Голос — из пула персоны
 * (LLM, прегенерация), ротация — per-session счётчиком в deps (не процесс-глобальная).
 * Без пула (тесты) — детерминированный seed.
 */
function butlerAck(deps: AgentDeps): string {
  const i = deps.ackRotation ?? 0;
  deps.ackRotation = i + 1;
  if (deps.acks) return deps.acks.pick(i);
  return DEFAULT_BUTLER_ACKS[i % DEFAULT_BUTLER_ACKS.length] ?? DEFAULT_BUTLER_ACKS[0]!;
}

/**
 * Запустить фоновую задачу (§20 async). Независимые задачи бегут ПАРАЛЛЕЛЬНО — за общую
 * мышь/клаву отвечает аренда ввода (§20) внутри runAgentLoop/runLocalIntent, не глобальная
 * серия. bounded=true — под ограничителем параллельных agent-loop'ов (не спамить LLM).
 * Итог озвучивается по готовности через speakResult; в мёртвую сессию — молчим.
 */
function startBackgroundTask(
  run: () => Promise<AgentReply>,
  deps: AgentDeps,
  opts: { bounded: boolean },
): void {
  const sem = opts.bounded ? deps.concurrency : undefined;
  const task = (async () => {
    if (sem) await sem.acquire();
    try {
      const reply = await run();
      deps.memory.pushTurn("assistant", reply.voice);
      if (reply.voice.trim() && !deps.isClosed?.()) deps.speakResult?.(reply);
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

/** Полный agent-loop с tool-use (§7, §8). */
async function runAgentLoop(
  session: Session,
  text: string,
  tier: Exclude<Tier, "tier0">,
  deps: AgentDeps,
): Promise<AgentReply> {
  // Тир можно ПОВЫСИТЬ прямо в петле, если модель застревает (§7, принцип «не сдаваться»):
  // haiku → sonnet → fable. Так слабая модель не упирается, а заходит сильнее.
  let currentTier = tier;
  let model = deps.models[currentTier];

  // Долгая задача (§20): общий с router реестр (или локальный для изолированных тестов).
  const tasks = deps.tasks ?? new TaskManager();
  const task = tasks.create({ userId: deps.userId, sessionId: session.sessionId, goal: text });
  const taskId = task.taskId;

  // Аренда ввода (§20): задача занимает мышь/клаву на ПЕРВОЙ GUI-команде и держит до
  // конца (исключает interleave кликов/печати с другой параллельной задачей). Пока
  // занимается только чтением/web/памятью/кодом — ввод свободен для других задач.
  const arbiter = deps.inputArbiter;
  let holdsInput = false;
  const ensureInput = async (): Promise<void> => {
    if (!arbiter || holdsInput) return;
    await arbiter.acquire();
    holdsInput = true;
    // Могли отменить, пока ждали аренду (§20 «отмена ≤1 шага»): сразу отдаём её —
    // петля выйдет на ближайшей проверке cancel, не выполнив GUI-команду.
    if (task.cancel.cancelled) {
      arbiter.release();
      holdsInput = false;
    }
  };
  // Прогресс показываем (панель + кнопка «стоп» в renderer) только когда задача реально
  // многошаговая (пошёл tool-use) — чтобы не мигать панелью на простых ответах (§20).
  let shown = false;
  const showStatus = (): void => {
    shown = true;
    emitTaskStatus(session, task);
  };

  // Retrieval-augmentation: релевантные факты из эпизодической памяти (§8). RAG
  // НЕОБЯЗАТЕЛЕН — под жёстким таймаутом (§10): лучше ответить без фактов, чем повесить
  // весь ход на медленной/зависшей БД (это и был баг «Джарвис не отвечает»).
  let facts: string[] = [];
  try {
    const hits = await withTimeout(deps.episodic.search(deps.userId, text, 5), 2000);
    facts = hits.map((h) => h.episode.text);
  } catch (e) {
    log.debug("retrieval пропущен (таймаут/ошибка)", e instanceof Error ? e.message : String(e));
  }

  // §8 HERMES: подобрать выученный навык-процедуру под задачу (recall). Как и факты —
  // НЕОБЯЗАТЕЛЬНО, под жёстким таймаутом: лучше идти без навыка, чем повесить ход на БД.
  // Если навык найден — его процедура вшивается в системный промпт, и модель ей СЛЕДУЕТ.
  let recalled: RecalledSkill | null = null;
  if (deps.skills) {
    try {
      recalled = await withTimeout(deps.skills.recall(deps.userId, text), 2000);
    } catch (e) {
      log.debug("recall навыка пропущен (таймаут/ошибка)", e instanceof Error ? e.message : String(e));
    }
  }
  if (recalled) log.info("recall навыка (§8)", { id: recalled.id, version: recalled.version });

  const sys = buildSystemPrompt({
    ...deps.userContext,
    facts,
    // Тон активного режима-маски (§11): берём из профиля (переживает рестарт), оверлеем поверх персоны.
    personaTone: getMode(getProfile().mode).overlay || undefined,
    ...(recalled ? { learnedSkill: formatRecalledSkill(recalled) } : {}),
  });
  // Набор = встроенные (минус служебные) + самописные инструменты (§8+ саморасширение):
  // выученные Джарвисом инструменты становятся вызываемыми наравне со штатными.
  const tools = [
    ...TOOL_SCHEMAS.filter((t) => !EXCLUDED_TOOLS.has(t.name)),
    ...(deps.dynamicTools?.asToolSchemas() ?? []),
  ];

  // Контекст диалога из рабочей памяти (§8).
  const convo: LlmMessage[] = deps.memory
    .recentTurns()
    .map((t) => ({ role: t.role, content: t.text }) as LlmMessage);
  // Opus 4.8 не принимает префилл: convo ДОЛЖЕН заканчиваться сообщением пользователя.
  // Страховка от хвостовых assistant-сообщений (дворецкий ack, гонки фоновых задач).
  while (convo.length > 0 && convo[convo.length - 1]?.role !== "user") convo.pop();

  const toolCtx = {
    session,
    web: deps.web,
    episodic: deps.episodic,
    userId: deps.userId,
    // Подтверждение необратимого (§14): kind задаёт вид модалки (send|order|irreversible),
    // чтобы удаление/выключение/код не показывались как обычная «отправка».
    confirm: (summary: string, kind: "send" | "order" | "irreversible" = "send") =>
      session
        .requestConfirm({ requestId: newId(), summary, kind, expiresAt: Date.now() + 60_000 })
        .then((r) => ({ approved: r.approved, revision: r.revision })),
    dynamicTools: deps.dynamicTools,
    skills: deps.skills,
    telegramSend: deps.telegramSend, // §6: невидимая отправка в TG через расширение
  };
  let finalText = "";

  // Жёсткий кап шагов + предохранитель SpendGuard (max шагов/токенов/трат §14).
  const HARD_STEP_CAP = 50;
  let cancelled = false;
  let limited = false;
  let round = 0; // число завершённых tool-use раундов (= прогресс задачи)
  let cacheReadTokens = 0; // метрики prompt-кеша за задачу (§15)
  let cacheCreationTokens = 0;
  let failed = false;
  // §8 HERMES: траектория инструментов (для нуджа самообучения) + флаг «навык уже сохранён
  // в этой задаче» (модель вызвала skill_save сама) → не нуждить повторно после петли.
  const toolTrajectory: string[] = [];
  let skillSavedInLoop = false;
  // Был ли хоть один НЕошибочный инструмент: finalText ставится и когда модель сдалась после
  // сплошных ошибок (is_error в результатах не бросает исключение) — это НЕ успех, навык не
  // сохраняем (иначе recall впредь подсунул бы «приём» из проваленной задачи).
  let anyToolSucceeded = false;
  let consecErrorRounds = 0; // подряд провальных раундов → эскалация тира (§7)
  const ESCALATE_AFTER = 2;
  // Любое исключение из шага (брошенный dispatchTool, reject провайдера) НЕ должно
  // оставить задачу в running и подвесить счётчик SpendGuard — ловим и финализируем.
  try {
  for (let step = 0; step < HARD_STEP_CAP; step += 1) {
    // Отмена ≤1 шага (§20): cancel-флаг проверяется ПЕРЕД каждым шагом. Команда
    // «отмени» из router мутирует ТОТ ЖЕ флаг между await'ами петли.
    if (task.cancel.cancelled) {
      cancelled = true;
      break;
    }

    // Пауза реальна (§20, user-takeover §6): пока задача paused — петля ЖДЁТ, не шлёт
    // новых команд. Пользователь взял мышь → агент уступил; освободил → петля продолжит.
    await waitWhilePaused(task);
    if (task.cancel.cancelled) {
      cancelled = true; // могли отменить, пока стояли на паузе
      break;
    }
    if (task.state === "paused") {
      // Вышли по ПОТОЛКУ ожидания (resume не пришёл), а не по возобновлению. НЕЛЬЗЯ
      // выполнять шаг на «уступленной» сессии (нарушило бы takeover) — снимаем задачу.
      log.warn("пауза превысила потолок ожидания — снимаю задачу", { taskId });
      tasks.cancel(taskId);
      cancelled = true;
      break;
    }

    const guard = deps.spend.check(taskId, 0.01, 2000);
    if (!guard.allowed) {
      log.warn("предохранитель остановил петлю", { reason: guard.reason });
      limited = true;
      break;
    }

    // §15: кешируем префикс только в «тёплой» сессии. Первый вызов холодной
    // сессии — тощий префикс без кеша (не платить 1.25× за разовую перезапись);
    // последующие в петле — уже тёплые. Кеш-брейкпоинт растущего диалога — только
    // когда кешируем (system+tools кешируются статичным брейкпоинтом в anthropic.ts).
    const warmth = deps.warmth ?? sharedWarmth;
    const cachePrefix = step === 0 ? warmth.isWarm(session.sessionId) : true;
    if (cachePrefix) markCacheBreakpoint(convo);

    const resp = await deps.llm.complete({
      tier: currentTier,
      model,
      systemStatic: sys.staticPrefix,
      systemDynamic: sys.dynamicSuffix || undefined,
      messages: convo,
      tools,
      cachePrefix,
    });
    warmth.touch(session.sessionId);
    deps.spend.recordStep(taskId);
    deps.spend.recordUsage(taskId, resp.usage.inputTokens + resp.usage.outputTokens, estimateCost(resp.usage));
    cacheReadTokens += resp.usage.cacheReadTokens;
    cacheCreationTokens += resp.usage.cacheCreationTokens;

    if (resp.toolUses.length === 0) {
      finalText = resp.text || "Готово.";
      break;
    }

    // Пошёл tool-use → это настоящая многошаговая задача: показываем прогресс (§20).
    if (!shown) showStatus();

    // Реплеим ход ассистента (текст + tool_use) и результаты инструментов.
    const assistantBlocks: LlmContentBlock[] = [];
    if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
    for (const tu of resp.toolUses) {
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    convo.push({ role: "assistant", content: assistantBlocks });

    const resultBlocks: LlmContentBlock[] = [];
    for (const tu of resp.toolUses) {
      // GUI-команда (клик/печать/фокус/окно/скилл) → берём аренду ввода ДО исполнения,
      // чтобы не столкнуться с параллельной задачей за курсор (§20). Держим до конца задачи.
      if (toolNeedsInput(tu.name)) {
        await ensureInput();
        // Отменили, пока ждали аренду — НЕ шлём GUI-команду (аренду ensureInput уже отдал).
        if (task.cancel.cancelled) break;
      }
      const r = await dispatchTool(tu.name, tu.input, toolCtx);
      log.info("tool", { name: tu.name, isError: r.isError });
      // §8: копим траекторию для самообучения; отмечаем успех и уже-сохранённый навык.
      toolTrajectory.push(`${tu.name}${r.isError ? " (ошибка)" : ""}`);
      if (!r.isError) anyToolSucceeded = true;
      if (tu.name === "skill_save" && !r.isError) skillSavedInLoop = true;
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      });
    }
    convo.push({ role: "user", content: resultBlocks });

    // Эскалация тира (§7): если раунд провалился ЦЕЛИКОМ (все инструменты вернули ошибку)
    // ESCALATE_AFTER раз подряд — модель застряла → заходим сильнее (haiku→sonnet→fable),
    // вместо того чтобы сдаться на слабой модели. Один успешный инструмент сбрасывает счётчик.
    const allErrored =
      resultBlocks.length > 0 && resultBlocks.every((b) => b.type === "tool_result" && b.is_error === true);
    if (allErrored) {
      consecErrorRounds += 1;
      if (consecErrorRounds >= ESCALATE_AFTER && currentTier !== "fable") {
        currentTier = currentTier === "haiku" ? "sonnet" : "fable";
        model = deps.models[currentTier];
        consecErrorRounds = 0;
        log.info("эскалация тира: модель застряла — захожу сильнее", { to: currentTier });
        // Filler: дать понять, что не зависли, а пробуем иначе (а не молчать на застревании).
        session.send("transcript", { text: "Секунду, зайду с другой стороны.", final: true });
      }
    } else {
      consecErrorRounds = 0;
    }

    round += 1;
    tasks.progress(taskId, round);
    if (shown) emitTaskStatus(session, task);
  }
  } catch (e) {
    log.error("agent-loop: исключение в петле", { error: e instanceof Error ? e.message : String(e) });
    failed = true;
  } finally {
    // Освобождаем аренду ввода на ЛЮБОМ выходе (успех/отмена/лимит/исключение, §20),
    // иначе следующая задача навечно зависнет на acquire. Терминал ниже ввод не трогает.
    if (holdsInput && arbiter) arbiter.release();
  }

  // §8 HERMES самообучение: задача решена САМА (многошагово, успешно), готового навыка не
  // было (recalled===null) и сам не сохранил по ходу → один бэкстоп-ход предлагает сохранить
  // приём навыком. Узкий набор (только skill_save/skill_list) — рефлексия не делает реальных
  // действий. Не критично для пользователя: ошибки глушим, итог уже готов (finalText).
  if (!failed && !limited && !cancelled && finalText && anyToolSucceeded && round >= 3 && !recalled && !skillSavedInLoop && deps.skills) {
    await selfLearnSkill({
      deps,
      sys,
      convo,
      finalText,
      round,
      toolTrajectory,
      toolCtx,
      tier: currentTier,
      model,
      taskId,
    }).catch((e) => log.debug("self-learn навыка пропущен", e instanceof Error ? e.message : String(e)));
  }

  deps.spend.finishTask(taskId);
  if (cacheReadTokens + cacheCreationTokens > 0) {
    log.info("prompt-кеш (§15)", { cacheReadTokens, cacheCreationTokens });
  }

  // Терминал задачи (§20): отмена / лимит / успех — со стримом task.status.
  if (cancelled) {
    // state уже "cancelled" (выставил router через tasks.cancel) — досылаем финальный статус.
    if (shown) emitTaskStatus(session, task);
    return { voice: verbalize("Хорошо, остановил.") };
  }
  if (failed) {
    tasks.fail(taskId, "ошибка выполнения задачи");
    if (shown) emitTaskStatus(session, task);
    return { voice: verbalize("Не смог выполнить — произошла ошибка.") };
  }
  if (limited) {
    tasks.fail(taskId, "достигнут лимит на задачу (spend cap §14)");
    if (shown) emitTaskStatus(session, task);
    return { voice: verbalize("Остановился — достигнут лимит на задачу.") };
  }
  if (!finalText) finalText = "Готово.";
  tasks.finish(taskId, finalText);
  if (shown) emitTaskStatus(session, task);
  return { voice: verbalize(finalText) };
}

/** Интервал опроса паузы и потолок ожидания (§20): не зависаем навсегда. */
const PAUSE_POLL_MS = 150;
const MAX_PAUSE_MS = 5 * 60_000;

/**
 * Кооперативная пауза (§20, user-takeover §6): пока задача в состоянии "paused" —
 * ждём (опрос), но не дольше MAX_PAUSE_MS и сразу выходим при отмене. Возобновление
 * (state→running) делает router (task.control resume / client.takeover active:false).
 */
export async function waitWhilePaused(task: Task, nowFn: () => number = () => Date.now()): Promise<void> {
  const start = nowFn();
  while (task.state === "paused" && !task.cancel.cancelled && nowFn() - start < MAX_PAUSE_MS) {
    await sleep(PAUSE_POLL_MS);
  }
}

/** Стрим прогресса/состояния задачи на клиент (§20, task.status → renderer-панель). */
function emitTaskStatus(session: Session, task: Task): void {
  const payload: TaskStatus = {
    taskId: task.taskId,
    state: task.state,
    summary: task.goal,
    stepsDone: task.stepsDone,
    stepsTotal: task.stepsTotal,
  };
  session.send("task.status", payload);
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
): Promise<AgentReply> {
  if (arbiter) await arbiter.acquire();
  try {
    // Сессия закрылась, ПОКА ждали аренду (фоновая tier0-команда §20) — НЕ крадём фокус
    // мёртвой сессии (открытие приложения/сайта на уже ушедшем пользователе). Пустой voice
    // → startBackgroundTask его не озвучивает.
    if (isClosed?.()) return { voice: "" };
    const command = intentToCommand(intent);
    const result = await session.sendAction(command, DEFAULT_ACTION_TIMEOUT_MS);
    void insertActionLog(buildActionLogEntry(session.sessionId, result.commandId, command, result));
    if (result.ok) return { voice: verbalize(successPhrase(intent)) };
    log.warn("локальное действие не удалось", { kind: command.kind, code: result.error?.code });
    return { voice: verbalize(failurePhrase(intent, result.error?.code)) };
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
      return { kind: "browser.open", url: intent.url };
  }
}

function successPhrase(intent: LocalIntent): string {
  switch (intent.kind) {
    case "app.launch":
      return `Открыл ${intent.app}, сэр.`;
    case "app.focus":
      return `Переключился на ${intent.app}, сэр.`;
    case "browser.open":
      return "Открыл, сэр.";
  }
}

function failurePhrase(intent: LocalIntent, code?: string): string {
  const reason =
    code === "timeout"
      ? "не дождался ответа"
      : code === "not_found"
        ? "не нашёл"
        : code === "disconnected"
          ? "связь с клиентом прервалась"
          : "не получилось";
  switch (intent.kind) {
    case "app.launch":
      return `Не вышло открыть ${intent.app}: ${reason}.`;
    case "app.focus":
      return `Не вышло переключиться на ${intent.app}: ${reason}.`;
    case "browser.open":
      return `Не вышло открыть страницу: ${reason}.`;
  }
}

/**
 * Грубая оценка стоимости вызова (для spend cap §14). Порядок величины в
 * нормализованных единицах: вход=1, кеш-чтение=0.1, кеш-запись=1.25, выход=5 —
 * отражает экономию prompt-кеша (§15).
 */
function estimateCost(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    (usage.inputTokens * 1 +
      usage.cacheReadTokens * 0.1 +
      usage.cacheCreationTokens * 1.25 +
      usage.outputTokens * 5) /
    1_000_000
  );
}

/**
 * Кеш-брейкпоинт растущего диалога (§15): держим РОВНО одну метку — на последнем
 * блоке последнего сообщения. Прежние снимаем, чтобы не упереться в лимит
 * брейкпоинтов Anthropic (≤4). Первый ход (content — строка) пропускаем.
 */
export function markCacheBreakpoint(convo: LlmMessage[]): void {
  for (const m of convo) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "text" || b.type === "tool_result") delete b.cache_control;
    }
  }
  const last = convo.at(-1);
  if (!last || typeof last.content === "string") return;
  const lastBlock = last.content.at(-1);
  if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_result")) {
    lastBlock.cache_control = { type: "ephemeral" };
  }
}

/**
 * Блок системного промпта из подобранного recall'ом навыка (§8 HERMES). Подаём его как
 * РУКОВОДСТВО к действию (следуй, если подходит), а не как факт — и явно разрешаем
 * игнорировать, если к текущей задаче навык не подходит (recall лексический, не идеален).
 */
function formatRecalledSkill(s: RecalledSkill): string {
  return [
    `Навык «${s.name}» — применять, когда: ${s.when || "похожая задача"}.`,
    "",
    "Процедура (твой прошлый успешный приём):",
    s.procedure,
    "",
    "Следуй ей гибко, адаптируя под текущую задачу. Если к этой задаче она не подходит — игнорируй.",
  ].join("\n");
}

/** Узкий набор для рефлексии самообучения (§8): только мета-навыки, без реальных действий. */
const SELF_LEARN_TOOLS = TOOL_SCHEMAS.filter((t) => t.name === "skill_save" || t.name === "skill_list");
/** Потолок ходов рефлексии самообучения — бэкстоп, не должен раздувать стоимость задачи. */
const MAX_SELF_LEARN_STEPS = 4;

/**
 * Бэкстоп самообучения (§8 HERMES): после успешной многошаговой задачи без готового навыка
 * предлагаем модели сохранить приём через skill_save. Один-несколько узких ходов (только
 * skill_save/skill_list) — модель либо пишет навык, либо отвечает текстом (отказ). Итог
 * пользователю уже отдан; это фоновая дозапись знания, она не влияет на голосовой ответ.
 */
async function selfLearnSkill(args: {
  deps: AgentDeps;
  sys: { staticPrefix: string; dynamicSuffix: string };
  convo: LlmMessage[];
  finalText: string;
  round: number;
  toolTrajectory: readonly string[];
  toolCtx: ToolContext;
  tier: Exclude<Tier, "tier0">;
  model: string;
  taskId: string;
}): Promise<void> {
  const { deps, sys, convo, finalText, round, toolTrajectory, toolCtx, tier, model, taskId } = args;
  const trajectory = toolTrajectory.length > 0 ? toolTrajectory.join(" → ") : "—";
  const nudge =
    `[самообучение §8] Задача решена за ${round} шагов, готового навыка не было. ` +
    "Если этот приём пригодится для похожих задач в будущем — СОХРАНИ его одним вызовом " +
    "skill_save({name, when, procedure}): описывай обобщённо (без разовых значений этой задачи), " +
    "procedure — шаги по порядку + грабли + как проверить результат. " +
    `Твоя траектория инструментов: ${trajectory}. ` +
    "Если приём разовый и сохранять нечего — просто ответь коротким текстом, без вызова инструмента.";
  // Хвост диалога заканчивается user-сообщением (tool_result) — добавляем ассистентский итог
  // и user-нудж, чтобы convo по-прежнему оканчивался пользователем (Opus 4.8 не берёт префилл).
  const reflectConvo: LlmMessage[] = [
    ...convo,
    { role: "assistant", content: finalText },
    { role: "user", content: nudge },
  ];

  // Отдельный счётчик шагов под рефлексию: иначе длинная (у потолка maxStepsPerTask) задача —
  // ровно та, которой навык нужнее всего — не смогла бы сохранить приём (§14). spendCap и
  // kill-switch (глобальные) при этом продолжают действовать — платный цикл всё равно ограничен.
  const reflectId = `${taskId}:reflect`;
  try {
    for (let s = 0; s < MAX_SELF_LEARN_STEPS; s += 1) {
      const guard = deps.spend.check(reflectId, 0.01, 2000);
      if (!guard.allowed) {
        // Отличаем «предохранитель не пустил» от «модель решила не сохранять» (телеметрия).
        log.info("самообучение пропущено предохранителем (§14)", { reason: guard.reason });
        return;
      }

      const resp = await deps.llm.complete({
        tier,
        model,
        systemStatic: sys.staticPrefix,
        systemDynamic: sys.dynamicSuffix || undefined,
        messages: reflectConvo,
        tools: SELF_LEARN_TOOLS,
      });
      deps.spend.recordStep(reflectId);
      deps.spend.recordUsage(reflectId, resp.usage.inputTokens + resp.usage.outputTokens, estimateCost(resp.usage));

      if (resp.toolUses.length === 0) return; // модель решила не сохранять — это нормально

      const assistantBlocks: LlmContentBlock[] = [];
      if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
      for (const tu of resp.toolUses) {
        assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      reflectConvo.push({ role: "assistant", content: assistantBlocks });

      const resultBlocks: LlmContentBlock[] = [];
      let saved = false;
      for (const tu of resp.toolUses) {
        const r = await dispatchTool(tu.name, tu.input, toolCtx);
        resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError });
        if (tu.name === "skill_save" && !r.isError) saved = true;
      }
      reflectConvo.push({ role: "user", content: resultBlocks });
      if (saved) {
        log.info("самообучение: навык сохранён после задачи (§8)");
        return;
      }
    }
  } finally {
    deps.spend.finishTask(reflectId); // не копим счётчики ephemeral-метра рефлексии
  }
}
