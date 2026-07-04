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
import { actionTimeoutMs, newId } from "@jarvis/protocol";
import { type AsyncMutex, type Logger, type Semaphore, type ThinkingEffort, type Tier, createLogger, sleep } from "@jarvis/shared";
import { COLD_TOOL_NAMES, TOOL_SCHEMAS, type ToolSchema, toolCatalogLine } from "@jarvis/tools";
import type { McpManager } from "../mcp/manager.js";
import { toolNeedsInput } from "../tools/input-kinds.js";
import { cleanDisfluency } from "../nlu/disfluency.js";
import { buildActionLogEntry, insertActionLog } from "../../db/action-log.js";
import type { Session } from "../../gateway/session.js";
import type { ILlmProvider, LlmContentBlock, LlmMessage, LlmResponse } from "../../integrations/llm.js";
import { pruneStaleImages } from "./prune-images.js";
import { type GestureEvent, compileReplayLines } from "../../memory/skill-macro.js";
import { SentenceChunker, splitIntoSentences } from "../nlu/sentences.js";
import type { IWebProvider } from "../../integrations/web.js";
import { type EpisodicMemory, memoryMinScore } from "../../memory/episodic.js";
import type { WorkingMemory } from "../../memory/working.js";
import type { SpendGuard } from "../../billing/index.js";
import { type UserContextSlot, buildSystemPrompt } from "../persona/index.js";
import { getProfile, setDisplayName, setEmotion, setMode } from "../profile.js";
import { getMode, matchModeCommand } from "../persona/modes.js";
import { emotionName, emotionOverlay, matchEmotionCommand } from "../persona/emotion.js";
import { claimsObservedResult, isBlindMutate, isHollowSuccess, looksLikeGiveUp, maskedFailureReply, toolEffect } from "./error-voice.js";
import { type LocalIntent, classifyTier, resolveClarifyAnswer } from "../router/index.js";
import { cap, failurePhrase, pick, successPhrase } from "../verbalize/action-phrases.js";
import { type ToolContext, dispatchTool } from "../tools/dispatch.js";
import type { DynamicToolStore } from "../tools/dynamic.js";
import type { RecalledSkill, SkillProvider } from "../../memory/skills.js";
import type { TradingService } from "../trading/index.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { SemanticResponseCache } from "../response-cache.js";
import { formatSkillCatalog } from "../../memory/skills.js";
import { verbalize } from "../verbalize/index.js";
import { TaskManager } from "../tasks/manager.js";
import type { ReminderService } from "../../proactive/reminders/service.js";
import type { WatchService } from "../../proactive/watch/service.js";
import type { ObligationStore } from "../../proactive/ambient/obligations.js";
import type { ResolutionMemory } from "../../memory/resolution-memory.js";
import { classifyTaskScope, isDuplicateGoal } from "../tasks/scope.js";
import { type Task, actionTitle, formatActiveTasks, formatRecentTasks } from "../tasks/task.js";
import { SessionWarmth } from "./warmth.js";
import { estimateCostUsd, metrics } from "../../obs/metrics.js";
import { costUsd } from "../../obs/pricing.js";

const log: Logger = createLogger("agent");

/** Тёплость сессий по умолчанию (§15), если не инъектирован общий через deps. */
const sharedWarmth = new SessionWarmth();

/**
 * §20 «осознание задач»: окно, за которое недавние терминальные задачи инжектятся в контекст для
 * ответа на «сделал?». 6 ч ≈ retention реестра по умолчанию (JARVIS_TASK_RETENTION_MS) — дальше задачи
 * и так вычищены sweep'ом из памяти. Не делаем больше, чтобы не таскать вчерашние задачи в каждый ход.
 */
const RECENT_TASKS_WINDOW_MS = 6 * 60 * 60_000;

/** Ответ агента по схеме §21. */
export interface AgentReply {
  voice: string;
  display?: { title?: string; markdown: string };
}

/**
 * Канал ПОФРАЗНОЙ выдачи реплики (§10 realtime token-streaming). Brain отдаёт голос
 * предложениями по мере генерации (sentence), карточку — display, финал — done(full).
 * Реализует голосовой пайплайн (он же синтезирует фразы и держит speaking-сессию).
 * Структурно совпадает с voice.ReplySink (слои развязаны, как AgentReply↔AgentReplyLike).
 */
export interface ReplySink {
  /**
   * Brain начал «думать» (перед обращением к LLM, §10 realtime). Пайплайн на это маскирует
   * пол латентности Opus коротким прекеш-филлером. Зовётся ТОЛЬКО на LLM-пути (не на
   * детерминированных имя/режим/tier0) — там ответ мгновенный, филлер не нужен.
   */
  thinking?(): void;
  /** Готовое предложение голоса (уже вербализовано под TTS, §21) — синтезировать сразу. */
  sentence(text: string): void;
  /** Карточка подробностей (§21). */
  display(card: { title?: string; markdown: string }): void;
  /** Реплика сгенерирована целиком (full — весь голос для транскрипта/памяти). */
  done(full: string): void;
}

/** Есть ли в строке произносимое содержимое (буква/цифра) — иначе в TTS не отдаём. */
const HAS_VOICE = /[\p{L}\p{N}]/u;

/** Вербализовать сырое предложение (§21) и отдать в sink, если есть что произносить. */
function emitSentence(sink: ReplySink, raw: string): void {
  const v = verbalize(raw);
  if (v && HAS_VOICE.test(v)) sink.sentence(v);
}

/**
 * Биржевые инструменты (§трейдинг): их использование переводит ход на МАКС модель (Opus), без тиров —
 * на бирже важна обдуманность. Страховка к роутеру `looksLikeTrading` (см. agent-loop).
 */
const TRADING_TOOLS: ReadonlySet<string> = new Set([
  "market_quote",
  "market_candles",
  "market_analyze",
  "tinkoff_portfolio",
  "trade_predict",
  "trade_winrate",
  "trade_predictions",
]);

/** Зависимости агента (инъекция для тестируемости и разделения слоёв). */
export interface AgentDeps {
  memory: WorkingMemory;
  llm: ILlmProvider;
  episodic: EpisodicMemory;
  web: IWebProvider;
  /** id моделей по тирам (§7). */
  models: Record<Exclude<Tier, "tier0">, string>;
  /** «Эффорт» рассуждения (thinking) по тиру (§7). Нет → без thinking. */
  tierThinking?: Record<Exclude<Tier, "tier0">, ThinkingEffort>;
  spend: SpendGuard;
  userId: string;
  /** §15 семантический кэш чисто-вербальных ответов (опц.) — пропуск LLM на близком фактическом повторе. */
  responseCache?: SemanticResponseCache;
  userContext?: UserContextSlot;
  /**
   * Консьерж (§): висящее уточнение — мы задали короткий вопрос («Волну или коллекцию?») и ждём
   * ответ. Per-session мутируемое состояние; следующая реплика сперва пробуется как ответ (tier0,
   * мгновенно), иначе уточнение сбрасывается и реплика маршрутизируется обычно.
   */
  pendingClarify?: { key: string };
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
  /** §15 ленивая загрузка: per-session набор подгруженных ХОЛОДНЫХ инструментов (через tool_load).
   *  Их схемы добавляются в набор со следующего хода; пустой/undefined — только горячие + каталог. */
  toolActivation?: Set<string>;
  /** § MCP-host: инструменты подключённых MCP-серверов (холодные — в каталог; активированные — в набор). */
  mcp?: McpManager;
  /** Провайдер выученных показом навыков (§8); общий с gateway. */
  skills?: SkillProvider;
  /** §трейдинг (слой 1): рыночные данные + технический анализ (только чтение, без денег). */
  market?: TradingService;
  /** §экспертность: база знаний по доменам — свериться перед экспертной задачей. */
  knowledge?: KnowledgeBase;
  /** Отправка в Telegram через браузерное расширение (§6): невидимо, фоновой вкладкой. */
  telegramSend?: (to: string, text: string) => Promise<unknown>;
  /** Отправка ГОЛОСОВОГО в TG (расширение записывает голосом филиппа). */
  telegramSendVoice?: (to: string, audioB64: string) => Promise<unknown>;
  /** Синтез TTS (филипп) → mp3 base64 — для голосовых сообщений. */
  synthVoice?: (text: string) => Promise<string>;
  /**
   * Открыть URL в браузере пользователя через расширение С УЧЁТОМ открытых вкладок (§): есть
   * вкладка сервиса → фокус, нет → новая (не плодим дубли). Reject (нет расширения) → откат на
   * shell-open. Для «просто открой/включи» (inDefault) — основной путь, когда расширение подключено.
   */
  openOrFocus?: (url: string) => Promise<unknown>;
  /**
   * Браузер пользователя через расширение (§): `browser_open`/`browser_read`/`browser_act` действуют
   * в ЕГО реальных вкладках (chrome.tabs/scripting) — фокус существующей вкладки, не дубль. Прокидывается
   * в ToolContext.ext. Общий с gateway (brain.extBridge).
   */
  ext?: {
    readonly connected: boolean;
    openOrFocus(url: string): Promise<unknown>;
    tabRead(url?: string, tabId?: number): Promise<unknown>;
    tabInspect(url?: string, query?: string, cap?: number, tabId?: number): Promise<unknown>;
    tabAct(url: string, intent: string, params?: Record<string, unknown>, tabId?: number): Promise<unknown>;
    tabList(): Promise<unknown>;
    tabClose(url?: string, tabId?: number): Promise<unknown>;
    exportCookies(domains?: string[]): Promise<unknown>;
  };
  /** Сервис напоминаний (§9): durable-таймер + проактивная озвучка. Общий с gateway. */
  reminders?: ReminderService;
  /** Сервис наблюдений (§долгие-задачи): durable recurring-проверка условия + проактивная озвучка. Общий с gateway. */
  watch?: WatchService;
  /** Стор обязательств/счетов (§проактив-всё): ambient-движок проактивно напоминает по датам. Общий с gateway. */
  obligations?: ObligationStore;
  /** Опытная память резолва получателей (§ скорость): «помню, как зарезолвил». Общий с gateway. */
  resolutionMemory?: ResolutionMemory;
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
const EXCLUDED_TOOLS = new Set([
  "demo_record",
  "message_send",
  "order_place",
  // ЗРЕНИЕ: `screen_capture` теперь РЕАЛЬНЫЙ (Electron desktopCapturer → image-блок, screen.ts +
  // dispatch.lookAtScreen) — он в наборе (раньше был исключён как заглушка M3).
]);

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
  sink?: ReplySink,
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
  const activeTask = scopeEnabled ? deps.tasks?.active(session.sessionId) : undefined;
  const freshContext = Boolean(activeTask) && classifyTaskScope(clean) === "new";
  if (activeTask) {
    log.info("§20 область реплики при активной задаче", {
      active: activeTask.title,
      scope: freshContext ? "new (свежий контекст)" : "edit (контекст текущей)",
    });
    // §20 ПРАВКА НА ХОДУ: реплика-ПРАВКА («нет, не то» / «добавь ещё» / «переделай») во время активной
    // задачи — НЕ плодим вторую петлю и НЕ ждём её конца. Впрыскиваем в ИДУЩУЮ задачу (task.steer) —
    // петля подхватит перед ближайшим шагом — и сразу коротко подтверждаем. «new»-реплика (отдельное
    // дело) идёт прежним путём, самостоятельной параллельной задачей.
    if (!freshContext && deps.tasks?.steer(activeTask.taskId, clean)) {
      log.info("§20 правка впрыснута в активную задачу", { taskId: activeTask.taskId, active: activeTask.title });
      deps.memory.pushTurn("user", clean);
      return finishReply({ voice: "Принял, поправляю." });
    }
    // §20 ДУБЛЬ-ГЕЙТ (аудит 2026-07-02): «new»-реплика, почти дословно совпадающая с целью УЖЕ ИДУЩЕЙ
    // задачи (STT-вариация/нетерпеливый повтор: «продолжи/продолжу видео на ютубе» через 6 секунд), —
    // это не отдельное дело. Вторую параллельную петлю не плодим, коротко подтверждаем работу.
    if (freshContext && deps.tasks) {
      const dup = deps.tasks
        .list(deps.userId)
        .find((t) => (t.state === "running" || t.state === "paused") && t.sessionId === session.sessionId && isDuplicateGoal(clean, t.goal));
      if (dup) {
        log.info("§20 дубль активной задачи — вторую петлю не плодим", { taskId: dup.taskId, active: dup.title });
        deps.memory.pushTurn("user", clean);
        return finishReply({ voice: verbalize("Уже делаю, сэр.") });
      }
    }
  }

  // Консьерж (§): висит уточнение → пробуем реплику как ОТВЕТ на него (мгновенно, без LLM).
  // Одноразово: подошло — действуем; не подошло (сменил тему) — снимаем и маршрутизируем обычно.
  if (deps.pendingClarify) {
    const pend = deps.pendingClarify;
    deps.pendingClarify = undefined;
    const resolved = resolveClarifyAnswer(pend.key, clean);
    if (resolved) return finishReply(await runTier0(session, resolved, deps));
  }

  const decision = classifyTier(clean);
  log.info("маршрутизация", { tier: decision.tier, reason: decision.reason });

  // tier0 (запуск/фокус/сайт) — детерминированно, без LLM. Под арендой ввода (§20):
  // свободна → инлайн (мгновенно), занята фоновой задачей → не крадём фокус.
  if (decision.tier === "tier0" && decision.local) {
    // Консьерж: голая команда-сервис → мгновенный короткий вопрос + ждём ответ (НЕ действие).
    if (decision.local.kind === "clarify") {
      deps.memory.pushTurn("assistant", decision.local.question);
      deps.pendingClarify = { key: decision.local.key };
      return finishReply({ voice: decision.local.question });
    }
    return finishReply(await runTier0(session, decision.local, deps));
  }
  const tier: Exclude<Tier, "tier0"> = decision.tier === "tier0" ? "haiku" : decision.tier;

  // §15 Семантический кэш ответа: на близкий ФАКТИЧЕСКИЙ вопрос, на который уже был чисто-вербальный
  // ответ, отдаём кэш СРАЗУ — без вызова LLM (мгновенно, $0). Безопасно: кэшируются лишь ходы без
  // tool-use (см. store) → реплей не врёт «сделано»; lookup сам отсекает непригодные/командные запросы.
  if (deps.responseCache) {
    const cached = await deps.responseCache.lookup(deps.userId, clean);
    if (cached) {
      deps.memory.pushTurn("assistant", cached);
      return finishReply({ voice: cached });
    }
  }

  // ЗАДАЧА-ДЕЙСТВИЕ (sonnet/fable И НЕ разговор) + есть канал асинхронной озвучки → НЕ блокируем
  // разговор: работу гоним в фоне (§20), итог проговорим по готовности. ВОПРОС/рассуждение
  // (decision.conversational) сюда НЕ попадает — он отвечается СИНХРОННО ниже (стримом), без фоновой
  // задачи и дворецкого-ack (фикс «каждый вопрос воспринимает как задачу»). Независимые задачи бегут
  // ПАРАЛЛЕЛЬНО; конкуренцию за мышь/клаву разруливает аренда ввода (§20) внутри петли.
  if (decision.conversational !== true && (tier === "sonnet" || tier === "fable") && deps.speakResult) {
    startBackgroundTask(() => runAgentLoop(session, clean, tier, deps, undefined, { freshContext }), deps, { bounded: true });
    // §20 «тихий финал»: ход завершается БЕЗ произносимой фразы — итог придёт ОДИН раз через
    // speakResult. Раньше СРАЗУ звучал безусловный дворецкий ack («Принял») + результат следом =
    // ×2-3 фразы на КАЖДОМ ходе (жалоба). Теперь одна фраза — сам результат. Долгую многошаговую
    // задачу подсвечивает визуальная панель прогресса (task.status), голосового филлера нет.
    return finishReply({ voice: "" });
  }

  // haiku-болтовня / нет асинхронного канала (тесты) → синхронно. С sink — стримим пофразно
  // (§10): первый звук = синтез первого предложения, не всей реплики. done() вызовет finishReply.
  // conversational: вопрос/рассуждение — от хода НЕ ждём «дела» (mutate); маскированный провал
  // («Не вышло») на таком ходе — ложь в обратную сторону (живой случай: «сколько будет 2+2» +
  // tool_load → пустой финал → «нужное действие не сработало», хотя ничего не падало).
  const reply = await runAgentLoop(session, clean, tier, deps, sink, { freshContext, conversational: decision.conversational === true });
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
async function runTier0(session: Session, local: LocalIntent, deps: AgentDeps): Promise<AgentReply> {
  const arbiter = deps.inputArbiter;
  // §20/realtime: с голосовым каналом ВСЕГДА в фон, даже если аренда свободна. Иначе медленное
  // действие (browser.open висел 12с на CDP-таймауте) держит пайплайн в «думаю», где микрофон
  // в STT не кормится → Джарвис «перестаёт слышать». Фон: «принял» сразу → пайплайн слушает →
  // действие async (аренда ввода берётся внутри runLocalIntent), итог проговорим по готовности.
  // Мгновенные глобальные действия (медиа/громкость — keybd_event, не GUI-грундинг): СИНХРОННО, БЕЗ
  // ack-филлера и БЕЗ ожидания аренды ввода. Одна чистая фраза мгновенно — не плодим «Принял»+результат
  // на быстрой команде (лечит «×2 фразы» на медиа) и не ждём, пока освободится мышь от фоновой задачи.
  const instant = local.kind === "media" || local.kind === "volume";
  if (deps.speakResult && !instant) {
    startBackgroundTask(() => runLocalIntent(session, local, arbiter, deps.isClosed, deps.openOrFocus), deps, { bounded: false });
    // §20 «тихий финал»: результат действия («Открыл …») придёт ОДИН раз через speakResult —
    // без предварительного дворецкого ack (раньше «Принял»+«Открыл» = ×2 фразы на каждом открытии).
    return { voice: "" };
  }
  // instant → без аренды; прочее (тесты/dev.text) — инлайн под арендой (корректность > задержки).
  const useArbiter = !instant ? arbiter : undefined;
  if (useArbiter) await useArbiter.acquire();
  try {
    const reply = await runLocalIntent(session, local, undefined, undefined, deps.openOrFocus);
    deps.memory.pushTurn("assistant", reply.voice);
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

/** Полный agent-loop с tool-use (§7, §8). sink (§10) — пофразный стрим финальной реплики. */
async function runAgentLoop(
  session: Session,
  text: string,
  tier: Exclude<Tier, "tier0">,
  deps: AgentDeps,
  sink?: ReplySink,
  opts?: { freshContext?: boolean; conversational?: boolean },
): Promise<AgentReply> {
  // §10 realtime: сигналим «думаю» КАК МОЖНО РАНЬШЕ (до retrieval/recall/LLM) — пайплайн
  // замаскирует пол латентности Opus коротким филлером «Секунду, сэр.», пока идёт генерация.
  sink?.thinking?.();
  // Тир можно ПОВЫСИТЬ прямо в петле, если модель застревает (§7, принцип «не сдаваться»):
  // haiku → sonnet → fable. Так слабая модель не упирается, а заходит сильнее.
  let currentTier: Exclude<Tier, "tier0"> = tier;
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

  // Retrieval (§8 факты из эпизодической памяти) + recall навыка (§8 HERMES) — оба
  // НЕОБЯЗАТЕЛЬНЫ, под жёстким таймаутом (§10: лучше ответить без них, чем повесить ход на
  // медленной БД) и НЕЗАВИСИМЫ → гоним ПАРАЛЛЕЛЬНО. Раньше шли серией (до ~2с+2с лишней
  // задержки ПЕРЕД первым токеном LLM) — на realtime-пути это заметная мёртвая пауза.
  // На ГОЛОСОВОМ пути (sink) таймаут жёсткий: память НЕ должна держать первый токен. Бюджет 350мс
  // обычно ловит эмбеддинг+поиск, иначе отвечаем без пары фактов (модель добёрет memory_search при
  // надобности). На фоновом/текстовом пути (ack маскирует задержку) — полные 2с с памятью.
  // §10 латентность: память НЕ держит первый токен. Голос (sink) — жёсткие 350мс. Текст/фон без sink
  // раньше ждал до 2000мс перед LLM (заметная пауза в чат-вкладке); снижено до 700мс — обычно ловит
  // эмбеддинг+поиск, иначе модель добёрет memory_search сама. Env-тюн (универсальность).
  const ioTimeoutMs = sink ? 350 : Math.max(150, Number.parseInt(process.env.JARVIS_RETRIEVAL_TIMEOUT_MS ?? "", 10) || 700);
  const factsP: Promise<string[]> = withTimeout(deps.episodic.search(deps.userId, text, 5, memoryMinScore()), ioTimeoutMs)
    .then((hits) => hits.map((h) => h.episode.text))
    .catch((e) => {
      log.debug("retrieval пропущен (таймаут/ошибка)", e instanceof Error ? e.message : String(e));
      return [];
    });
  // Если навык найден — его процедура вшивается в системный промпт, и модель ей СЛЕДУЕТ.
  const recallP: Promise<RecalledSkill | null> = deps.skills
    ? withTimeout(deps.skills.recall(deps.userId, text), ioTimeoutMs).catch((e) => {
        log.debug("recall навыка пропущен (таймаут/ошибка)", e instanceof Error ? e.message : String(e));
        return null;
      })
    : Promise.resolve(null);
  // §8 Фаза 3: каталог выученных навыков тянем ПАРАЛЛЕЛЬНО (без доп. латентности), используем ТОЛЬКО
  // при лексическом промахе recall — Claude сам применит подходящий по смыслу (без эмбеддингов).
  const catalogP: Promise<Array<{ name: string; when: string }>> = deps.skills?.learnedCatalog
    ? withTimeout(deps.skills.learnedCatalog(deps.userId), ioTimeoutMs).catch(() => [])
    : Promise.resolve([]);
  const [facts, recalled, catalog] = await Promise.all([factsP, recallP, catalogP]);
  if (recalled) log.info("recall навыка (§8)", { id: recalled.id, version: recalled.version });
  const skillCatalog = !recalled ? formatSkillCatalog(catalog) : "";

  // Тон = оверлей режима-маски (§11) + оверлей эмоции подачи (§21), оба из профиля (переживают
  // рестарт). Эмоция просит LLM подобрать СЛОВА под подачу (голос несёт её отдельно ролью TTS).
  const profile = getProfile(deps.userId);
  const personaTone =
    [getMode(profile.mode).overlay, emotionOverlay(profile.emotion)].filter(Boolean).join("\n\n") || undefined;
  // §20 «осознание задач»: (а) АКТИВНЫЕ задачи в полёте (кроме текущего хода) — чтобы на «сделал?» во
  // время фоновой работы ответить «ещё в работе», а не «ничего не делаю»; (б) последние ТЕРМИНАЛЬНЫЕ
  // из общего реестра (диск-персист §5, переживают рестарт) в окне retention — фактический ответ на
  // «что делал?». Оба блока — в НЕкешируемый хвост промпта (кеш §15 не трогаем).
  const nowMs = Date.now();
  const recentTasks = [
    formatActiveTasks(tasks.activeForUser(deps.userId, taskId), nowMs),
    formatRecentTasks(tasks.recentTerminal(deps.userId, { limit: 5, maxAgeMs: RECENT_TASKS_WINDOW_MS }), nowMs),
  ]
    .filter(Boolean)
    .join("\n\n");
  const sys = buildSystemPrompt({
    ...deps.userContext,
    facts,
    personaTone,
    ...(recalled ? { learnedSkill: formatRecalledSkill(recalled) } : {}),
    ...(skillCatalog ? { skillCatalog } : {}),
    ...(recentTasks ? { recentTasks } : {}),
  });
  // Набор = встроенные (минус служебные) + самописные инструменты (§8+ саморасширение):
  // выученные Джарвисом инструменты становятся вызываемыми наравне со штатными.
  // §15 ЛЕНИВАЯ ЗАГРУЗКА: «горячие» инструменты + холодные ТОЛЬКО если их подгрузили через tool_load
  // (per-session activation). Полные схемы холодных НЕ шлём каждый ход (контекст/латентность) — они
  // одной строкой в кешируемом каталоге `systemTools`; модель подгружает по имени. dispatch исполняет
  // инструмент по имени независимо от того, была ли схема в наборе (фолбэк-безопасность).
  const activation = deps.toolActivation; // Set<string> | undefined (имена подгруженных холодных)
  const isHot = (t: ToolSchema): boolean => !EXCLUDED_TOOLS.has(t.name) && (!COLD_TOOL_NAMES.has(t.name) || Boolean(activation?.has(t.name)));
  const mcpTools = deps.mcp?.asToolSchemas() ?? []; // § MCP-инструменты (все холодные)
  const tools = [
    ...TOOL_SCHEMAS.filter(isHot),
    ...(deps.dynamicTools?.asToolSchemas(deps.userId) ?? []),
    ...mcpTools.filter((t) => activation?.has(t.name)), // активированные через tool_load MCP → в набор
  ];
  // Каталог холодных (не подгруженных) — компактные однострочники, кешируемый блок (см. buildSystemBlocks).
  const coldCatalog = [
    ...TOOL_SCHEMAS.filter((t) => COLD_TOOL_NAMES.has(t.name) && !EXCLUDED_TOOLS.has(t.name) && !activation?.has(t.name)).map(toolCatalogLine),
    ...mcpTools.filter((t) => !activation?.has(t.name)).map((t) => `- ${t.name}: ${String(t.description || "").slice(0, 100)}`),
  ];
  const systemTools = coldCatalog.length
    ? `# Инструменты по запросу\nЕсть и другие инструменты (в т.ч. внешние MCP) — их полные описания не загружены. Нужен один — вызови tool_load{names:[...]} и используй со следующего хода:\n${coldCatalog.join("\n")}`
    : undefined;

  // Контекст диалога из рабочей памяти (§8). §20: «обособленная» новая задача (freshContext) НЕ
  // наследует ВЕСЬ контекст текущей, но и НЕ начинается слепой — иначе вопрос-продолжение («ты
  // отправил?», «ну что?») терял весь диалог и Джарвис отвечал «не вижу, о каком сообщении речь»
  // (реальный баг «забывашка»). Поэтому свежая задача берёт КОРОТКОЕ окно последних реплик
  // (continuity без раздувания), обычный ход — полный недавний диалог.
  const FRESH_CONTEXT_WINDOW = 10;
  const turns = opts?.freshContext ? deps.memory.recentTurns(FRESH_CONTEXT_WINDOW) : deps.memory.recentTurns();
  const convo: LlmMessage[] = turns.map((t) => ({ role: t.role, content: t.text }) as LlmMessage);
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
    market: deps.market, // §трейдинг: рыночные данные + анализ (только чтение)
    knowledge: deps.knowledge, // §экспертность: база знаний (свериться перед экспертной задачей)
    telegramSend: deps.telegramSend, // §6: невидимая отправка в TG через расширение
    telegramSendVoice: deps.telegramSendVoice, // §: голосовое в TG голосом филиппа
    synthVoice: deps.synthVoice, // §: синтез TTS для голосовых
    reminders: deps.reminders, // §9: durable-напоминания + проактивная озвучка
    watch: deps.watch, // §долгие-задачи: durable наблюдение/мониторинг + проактивная озвучка
    obligations: deps.obligations, // §проактив-всё: счета/обязательства (ambient напоминает по датам)
    origin: "user" as const, // §бесшумный-ввод: agent-петля исполняет реплику юзера → физ.ввод не гейтить присутствием

    resolutionMemory: deps.resolutionMemory, // §: опытная память резолва (скорость)
    sessionId: session.sessionId,
    ext: deps.ext, // §: браузер пользователя через расширение (browser_open/read/act в его вкладках)
    toolActivation: deps.toolActivation, // §15: набор подгруженных холодных инструментов (tool_load)
    mcp: deps.mcp, // § MCP-host: исполнение mcp__-инструментов через callTool
  };
  let finalText = "";

  // Жёсткий кап шагов + предохранитель SpendGuard (max шагов/токенов/трат §14).
  const HARD_STEP_CAP = 50;
  // Защитный потолок времени задачи (§20): даже если шаг где-то завис мимо своих таймаутов,
  // петля не остаётся в «выполняю» навечно — финализируем (терминал → панель/чип закрывается).
  // env JARVIS_TASK_MAX_MS (деф 4 мин, кламп [30с, 30мин]).
  const loopStartMs = Date.now();
  const loopMaxMs = (() => {
    const n = Number.parseInt(process.env.JARVIS_TASK_MAX_MS ?? "", 10);
    return Number.isFinite(n) ? Math.min(1_800_000, Math.max(30_000, n)) : 240_000;
  })();
  let cancelled = false;
  let limited = false;
  let timedOut = false;
  let round = 0; // число завершённых tool-use раундов (= прогресс задачи)
  let cacheReadTokens = 0; // метрики prompt-кеша за задачу (§15)
  let cacheCreationTokens = 0;
  // Телеметрия (obs/metrics): копим токены/вызовы за всю задачу для per-task события.
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let toolCallsTotal = 0;
  let failed = false;
  // §8 HERMES: траектория инструментов (для нуджа самообучения) + флаг «навык уже сохранён
  // в этой задаче» (модель вызвала skill_save сама) → не нуждить повторно после петли.
  const toolTrajectory: string[] = [];
  let skillSavedInLoop = false;
  // §8 МАКРОС: id навыка, сохранённого В ЭТОЙ задаче (skill_save в петле или self-learn после) —
  // адресат дозаписи авто-реплея жестов (generic: любое UIA-слепое приложение, не только recall-путь).
  let savedSkillId: string | null = null;
  // §8: задача потребовала самостоятельного research (web_search/web_fetch) — «не знал как, нашёл сам».
  // Такой приём ценно сохранить навыком даже на короткой траектории (иначе каждый раз гуглим заново).
  let wasResearched = false;
  // §20 чип «по смыслу»: заголовок задачи ставим из ПЕРВОГО значимого действия (а не из сырой
  // фразы STT). Ставится один раз — дальше не дёргаем, чтобы чип не прыгал.
  let semanticTitleSet = false;
  // Был ли хоть один НЕошибочный инструмент: finalText ставится и когда модель сдалась после
  // сплошных ошибок (is_error в результатах не бросает исключение) — это НЕ успех, навык не
  // сохраняем (иначе recall впредь подсунул бы «приём» из проваленной задачи).
  let anyToolSucceeded = false;
  // P0.1: успех ИМЕННО меняющего действия (toolEffect==="mutate"). Нейтральные (web_search/memory/
  // skill_*) НЕ считаются «дело сделано» — иначе «погуглил и сдался словами» проходит как успех, а
  // ложное «Готово» после одного поиска не ловится. Гейтим анти-капитуляцию и masked-failure по нему,
  // а anyToolSucceeded оставляем для self-learn/трейдинга (там важен ЛЮБОЙ успешный инструмент).
  let anyMutateSucceeded = false;
  let consecErrorRounds = 0; // подряд провальных раундов → эскалация тира (§7)
  const ESCALATE_AFTER = 2;
  // §10 realtime: финальная (конверсационная) реплика уже отдана в sink пофразно на 1-м ходе
  // (без tool_use) → терминал не дублирует её. На tool-ходах остаётся false → финал стримится
  // в конце целиком (пофразно). Стримим ТОЛЬКО 1-й ход: tool-результаты не произносим.
  let streamedFinal = false;
  // §10: уже произнесли пользователю хоть фразу (стрим преамбулы/ответа)? Тогда в сбойном терминале
  // НЕ говорим противоречивое «не смог» — иначе после куска ответа звучит «не смог выполнить».
  let spokeAny = false;
  // Anti-runaway (§20): сигнатура tool-вызовов прошлого раунда + счётчик одинаковых подряд.
  // Модель иногда зацикливается на ОДНОМ И ТОМ ЖЕ УСПЕШНОМ действии (открывает «до посинения»,
  // карточка задачи не закрывается) — ловим повтор и обрываем. Только УСПЕШНЫЙ повтор: подряд
  // ПАДАЮЩИЕ инструменты — это путь эскалации тира (§7), их не трогаем.
  let lastToolSig = "";
  let identicalRepeats = 0;
  // H4 (ревью 2026-07-02): повтор ТОГО ЖЕ успешного действия — признак НЕдостигнутой цели (жмёт play
  // в пустоту), а прежний обрыв с дефолтом «Готово, сэр.» был ложным успехом в обход verify-петли.
  // Теперь: один интервент-нудж (сверь глазами / смени подход), при упорстве — честный провал.
  let repeatNudged = false;
  let runawayStuck = false;
  // H2 (ревью 2026-07-02): LLM ушёл в аварийный стаб (stopReason==="stub" — сеть/ретраи исчерпаны).
  // Это ПРОВАЛ хода, а не ответ: нельзя финалить задачу успехом и нельзя кэшировать стаб-текст.
  let llmStubbed = false;
  // M5 (ревью 2026-07-04): если стаб УЖЕ отдан пользователю через sink (step0-стрим озвучил стаб-текст),
  // терминал НЕ должен писать в память/чат ДРУГОЙ текст, чем прозвучал вслух. Храним реально
  // произнесённый стаб-текст и переиспользуем его в терминале вместо подстановки чужой фразы.
  let stubSpokenText = "";
  // Пустой финал после инструментов (живой смоук 2026-07-02): модель «отдаёт ответ» в преамбуле
  // tool-раунда (она отбрасывается по дизайну §10) и закрывает ход пустым текстом → подставлялось
  // «Готово.» → на вопросе masked-failure превращал это в ложное «Не вышло». Один нудж — потребовать
  // содержательную финальную реплику.
  let emptyFinalNudged = false;
  // Мягкий anti-runaway по СЕМЕЙСТВУ: модель долбит ОДИН инструмент (web_act/browser_act/inspect…) много раз
  // с чуть РАЗНЫМ input — identicalRepeats (байт-в-байт) это НЕ ловит, и она флудит до max_steps (жалоба
  // «дублирует команды»). Считаем вызовы по ИМЕНИ за задачу: на пороге — интервент-нудж «смени подход» +
  // эскалация на Opus; упорствует дальше — честный обрыв. env JARVIS_TOOL_FAMILY_CAP.
  const toolNameCount = new Map<string, number>();
  let familyNudges = 0;
  const FAMILY_SOFT_CAP = (() => {
    const n = Number.parseInt(process.env.JARVIS_TOOL_FAMILY_CAP ?? "", 10);
    return Number.isFinite(n) && n >= 3 ? n : 6;
  })();
  // §20 ОТЛОЖЕННЫЙ ACK долгой фоновой задачи (аудит лога 2026-07-03: «прекрати поиск у доти» —
  // 33с полной тишины → пользователь снял задачу вручную, не зная, идёт ли она). «Тихий финал»
  // остаётся законом (никаких безусловных «Принял» на каждом ходе): фоновая задача (без sink)
  // живёт дольше порога и ни одна фраза не прозвучала → ОДИН короткий прогресс-маячок.
  // Cancel-safe ПО КОНСТРУКЦИИ: таймер читает task.cancel/state/spokeAny В МОМЕНТ срабатывания
  // (ровно требование из ретро ButlerAcks — слепой agent-таймер, не видящий cancel, стрелял
  // ack'ом после «отмени»). clearTimeout — в finally петли. env JARVIS_TASK_ACK_MS, 0 = выкл.
  const taskAckMs = (() => {
    const n = Number.parseInt(process.env.JARVIS_TASK_ACK_MS ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 8000;
  })();
  let ackTimer: NodeJS.Timeout | undefined;
  if (!sink && deps.speakResult && taskAckMs > 0) {
    ackTimer = setTimeout(() => {
      if (task.cancel.cancelled || task.state !== "running" || spokeAny || deps.isClosed?.()) return;
      spokeAny = true; // прозвучала фраза → сбойный терминал строит «…продолжение», не противоречит
      log.info("§20 отложенный ack: задача идёт дольше порога — говорю прогресс", { taskId, ms: taskAckMs });
      deps.speakResult?.({ voice: verbalize("Занимаюсь, сэр.") });
    }, taskAckMs);
    ackTimer.unref?.();
  }
  const MAX_FAMILY_NUDGES = 1;
  // §скорость (зрение): в контексте держим только N последних скринов (каждый ~2K токенов, старые —
  // мёртвый груз: модель обязана опираться на СВЕЖИЙ кадр). env JARVIS_KEEP_SCREENSHOTS, кламп [1,8].
  const KEEP_SCREENSHOTS = (() => {
    const n = Number.parseInt(process.env.JARVIS_KEEP_SCREENSHOTS ?? "", 10);
    return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 2;
  })();
  // §скорость: усиление family-нуджа ОДНОРАЗОВОЕ — раунд переосмысления идёт на сильной модели,
  // затем возвращаемся на прежний тир. Раньше эскалация была липкой, и вся оставшаяся МЕХАНИКА
  // задачи (клики/скрины по навыку) ехала на Opus в 2–3 раза медленнее по времени раунда (живой
  // замер «поиск в доте»: ~15с/раунд). Новые провалы после отката снова эскалируют штатно (§7).
  let familyBoost: { tier: Exclude<Tier, "tier0">; model: string; roundsLeft: number } | null = null;
  // Докрутка обрыва по лимиту вывода: модель не закончила (stop_reason=max_tokens) → продолжаем
  // генерацию с места обрыва, а не отдаём огрызок (большой код/реферат/курсовая). Кап продолжений
  // + общие потолки задачи (токены/шаги/время) защищают от runaway. Env JARVIS_MAX_CONTINUATIONS.
  let continuations = 0;
  const MAX_CONTINUATIONS = (() => {
    const n = Number.parseInt(process.env.JARVIS_MAX_CONTINUATIONS ?? "", 10);
    return Number.isFinite(n) && n >= 0 && n <= 20 ? n : 6;
  })();
  // Анти-капитуляция (§«не сдавайся»): если модель закрыла ход текстом-отказом, НЕ вызвав НИ ОДНОГО
  // инструмента, один раз форсим попытку (web_search/code_run), вместо принятия «не умею» как финала.
  let retryNudges = 0;
  const MAX_RETRY_NUDGES = (() => {
    const n = Number.parseInt(process.env.JARVIS_MAX_RETRY_NUDGES ?? "", 10);
    // P0.3: нижняя граница 1, не 0 — «не сдавайся» нельзя тихо выключить кривым .env (это LAW №1).
    return Number.isFinite(n) && n >= 1 && n <= 3 ? n : 2;
  })();
  // VERIFY-ПЕТЛЯ (анти-конфабуляция «врёт готово» + анти-«сдался не проверив», P0.2): после СЛЕПОГО
  // меняющего действия (клик/ввод/act-в-странице/фокус — ok ≠ цель достигнута) и ДО того, как модель
  // закроет ход, ОБЯЗАТЕЛЬНА сверка глазами (browser_read/inspect/screen_capture). Раньше триггер
  // требовал ещё regex-claim о содержимом → «Готово, музыка играет» (без слов-маркеров) проходил без
  // сверки. Теперь триггер СТРУКТУРНЫЙ: blindMutatePending. Самоподтверждающиеся mutate (code_run/fs/
  // office/system/launch/open) сверки НЕ требуют (их исход уже в tool_result) — см. isBlindMutate.
  let verifyNudges = 0;
  // P0.2: было жёстко 1 (сработав однажды, дальше не давил — конфабуляция второго действия проходила).
  // Теперь из env, дефолт 2, кламп [1,5] — verify обязателен СТРУКТУРНО, а не «один раз и забыли».
  const MAX_VERIFY_NUDGES = (() => {
    const n = Number.parseInt(process.env.JARVIS_MAX_VERIFY_NUDGES ?? "", 10);
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 2;
  })();
  // Висит ли НЕсверённое слепое действие: ставится при успешном слепом mutate, снимается сверкой глазами.
  let blindMutatePending = false;
  // §адаптация к цели: одноразовая сверка терминала с ИСХОДНОЙ задачей — ловит «выполнил подцель
  // (запустил приложение) и посчитал задачу сделанной» (живой случай: «запусти поиск в доте» →
  // «Дота запущена, сэр» без поиска). Кап 1 — не раздуваем задачу. Если ПОСЛЕДНИЙ инструментальный
  // раунд уже был сверкой глазами (screen_capture/read) — модель только что смотрела на результат,
  // лишний раунд не жжём (lastRoundHadVerify).
  let goalCheckDone = false;
  let lastRoundHadVerify = false;
  // §8 МАКРОС: трасса ЖЕСТОВ успешных GUI-инструментов (фокус/клики/клавиши) — после успеха задачи
  // механически компилируется в реплей-шаги навыка (skill-macro.ts), чтобы в следующий раз
  // исполниться детерминированно за секунды, без LLM-раундов.
  const gestureTrace: GestureEvent[] = [];
  const MACRO_TRACE_TOOLS = new Set(["app_focus", "input_click", "input_key", "input_type"]);
  // Любое исключение из шага (брошенный dispatchTool, reject провайдера) НЕ должно
  // оставить задачу в running и подвесить счётчик SpendGuard — ловим и финализируем.
  try {
  // ── §8 МАКРОС, быстрый путь: у recall'нутого навыка есть авто-реплей → гоним ЕГО ($0, секунды),
  // LLM остаётся одна сверка глазами. Провал реплея — честный откат на полную процедуру. Гейты:
  // только СВОЙ навык, только безопасные действия (фокус/клик/клавиши/пауза — никаких guard-шагов),
  // без незаполненных {{слотов}}. Аренда ввода берётся как у обычной GUI-задачи (release в finally).
  {
    const REPLAY_SAFE = new Set(["app.focus", "input.click", "input.key", "input.type", "wait"]);
    const replaySteps = recalled?.steps ?? [];
    const replayable =
      recalled &&
      !recalled.fromShared &&
      !recalled.needsReview &&
      replaySteps.length >= 2 &&
      replaySteps.every((s) => REPLAY_SAFE.has(s.action)) &&
      replaySteps.some((s) => s.action.startsWith("input.")) &&
      !/\{\{\s*[\w-]+\s*\}\}/u.test(JSON.stringify(replaySteps));
    if (replayable && recalled) {
      let note: string;
      try {
        await ensureInput();
        if (task.cancel.cancelled) throw new Error("cancelled");
        const t0 = Date.now();
        const res = await session.sendAction(
          { kind: "skill.execute", skillId: recalled.id, version: recalled.version, steps: replaySteps, params: {} },
          60_000,
        );
        note = res.ok
          ? `⚙️ Авто-макрос навыка «${recalled.name}» v${recalled.version} уже ОТРАБОТАЛ за ` +
            `${((Date.now() - t0) / 1000).toFixed(1)}с (${replaySteps.map((s) => s.action).join(" → ")}). ` +
            `НЕ повторяй эти шаги. Реплей слепой: сверь результат глазами (screen_capture) — цель достигнута → ` +
            `коротко подтверди; не достигнута → добей по процедуре навыка.`
          : `⚙️ Авто-макрос навыка «${recalled.name}» упал (${res.error?.message ?? res.error?.code ?? "runtime"}` +
            `${res.stepIndex !== undefined ? `, шаг ${res.stepIndex + 1}` : ""}) — вероятно, приложение не запущено ` +
            `или экран изменился. Выполни задачу по процедуре навыка обычным путём.`;
        log.info("§8 макрос: быстрый реплей", { id: recalled.id, ok: res.ok, ms: Date.now() - t0 });
      } catch (e) {
        note = `⚙️ Авто-макрос навыка не выполнился (${e instanceof Error ? e.message : String(e)}) — действуй по процедуре навыка.`;
        log.warn("§8 макрос: быстрый реплей не выполнился", { id: recalled.id, error: e instanceof Error ? e.message : String(e) });
      }
      // Вклеиваем итог реплея в ХВОСТ последнего user-сообщения (как steer §20) — convo обязан
      // оканчиваться пользователем, второй user-ход подряд не плодим.
      const last = convo[convo.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }, { type: "text", text: note }];
        else last.content.push({ type: "text", text: note });
      } else {
        convo.push({ role: "user", content: note });
      }
    }
  }
  for (let step = 0; step < HARD_STEP_CAP; step += 1) {
    // Отмена ≤1 шага (§20): cancel-флаг проверяется ПЕРЕД каждым шагом. Команда
    // «отмени» из router мутирует ТОТ ЖЕ флаг между await'ами петли.
    if (task.cancel.cancelled) {
      cancelled = true;
      break;
    }
    // Защитный потолок времени: задача не висит в «выполняю» бесконечно (§20).
    if (Date.now() - loopStartMs > loopMaxMs) {
      log.warn("agent-loop: превышен потолок времени задачи — финализирую", { taskId, ms: loopMaxMs });
      timedOut = true;
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

    // §20 ПРАВКА НА ХОДУ: пока задача шла, пользователь сказал «нет, не то» / «добавь ещё» — менеджер
    // (через handleUserText) положил текст в task.steer.pending. Сливаем ПЕРЕД шагом и впрыскиваем как
    // указание пользователя, чтобы модель НЕМЕДЛЕННО скорректировала курс, а не доделывала старое.
    // convo здесь валиден (хвост — user-сообщение: исходная реплика [строка] или tool_results [массив]).
    if (task.steer.pending.length > 0) {
      const steers = task.steer.pending.splice(0);
      const note =
        `⚡ ПОПРАВКА ПОЛЬЗОВАТЕЛЯ НА ХОДУ (применяй НЕМЕДЛЕННО, не игнорируй, не доделывай старое вслепую): ` +
        `${steers.map((s) => `«${s}»`).join("; ")}. Перепланируй текущие действия под это: смысл «делаешь не ` +
        `то / не так» → смени подход; «добавь / измени / вместо» → учти правку и веди к ОБНОВЛЁННОЙ цели.`;
      const last = convo[convo.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }, { type: "text", text: note }];
        else last.content.push({ type: "text", text: note });
      } else {
        convo.push({ role: "user", content: note });
      }
      // M4 (ревью 2026-07-04): цель СМЕНИЛАСЬ на ходу — гейты честности обязаны считаться заново
      // ОТНОСИТЕЛЬНО НОВОЙ цели. Иначе успех ПРЕДЫДУЩЕГО (теперь отменённого правкой) действия
      // маскирует провал скорректированной попытки → ложное «Готово». Сбрасываем накопленные
      // флаги наблюдения: успех-мутации, висящую слепую сверку, отметку goal-check и счётчик
      // verify-нуджей — чтобы verify/masked-failure проверялись с чистого листа под новую цель.
      anyMutateSucceeded = false;
      blindMutatePending = false;
      goalCheckDone = false;
      verifyNudges = 0;
      log.info("§20 правка на ходу впрыснута в петлю", { taskId, count: steers.length });
    }

    const guard = deps.spend.check(taskId, 0.01, 2000);
    if (!guard.allowed) {
      log.warn("предохранитель остановил петлю", { reason: guard.reason });
      limited = true;
      break;
    }

    // §скорость: family-boost исчерпан (раунд переосмысления прошёл) → откат на прежний тир.
    // Если тем временем эскалировал КТО-ТО ЕЩЁ (trading-инструменты и т.п.) — не трогаем: откат
    // делаем только из того же fable, в который сами поднимали.
    if (familyBoost) {
      if (familyBoost.roundsLeft > 0) {
        familyBoost.roundsLeft -= 1;
      } else {
        if (currentTier === "fable") {
          currentTier = familyBoost.tier;
          model = familyBoost.model;
          log.info("family-boost исчерпан — откат на прежний тир (§скорость)", { tier: currentTier });
        }
        familyBoost = null;
      }
    }

    // §15 СКОРОСТЬ: кешируем статичный префикс (персона+инструменты, большой) ВСЕГДА, с первого
    // хода. Голосовая сессия — всегда разговор (многоходовой), так что кеш-запись (1.25× один раз
    // на ход 0) окупается мгновенно: со 2-го хода Opus не перечитывает огромный префикс → заметно
    // меньше время до первого токена. Прежний gate «греть только тёплую сессию» экономил копейки,
    // но держал первые ходы холодными (медленными) — для realtime это плохой размен.
    const warmth = deps.warmth ?? sharedWarmth;
    const cachePrefix = true;
    if (cachePrefix) markCacheBreakpoint(convo);

    const llmReq = {
      tier: currentTier,
      model,
      systemStatic: sys.staticPrefix,
      systemSkill: sys.skillSuffix || undefined, // §8: навык — свой кеш-брейкпоинт (см. buildSystemBlocks)
      systemTools, // §15: каталог холодных инструментов — отдельный кешируемый блок (ленивая загрузка)
      systemDynamic: sys.dynamicSuffix || undefined,
      messages: convo,
      tools,
      cachePrefix,
      // §7 «эффорт» по тиру → thinking (модель-aware в anthropic). При эскалации currentTier меняется →
      // меняется и эффорт (Opus=adaptive deep). off → без размышления (быстро).
      thinking: deps.tierThinking?.[currentTier],
    };
    // §10 realtime: на ПЕРВОМ ходе с sink стримим текст пофразно (token-streaming) — НО ТОЛЬКО
    // для многопредложенных конверсационных реплик (как в плане: «пофразный — для много-
    // предложенных, 1 фраза — текущий путь»). Claude штатно выдаёт ТЕКСТОВУЮ ПРЕАМБУЛУ перед
    // tool_use («Сейчас гляну…» → web_read); чтобы её НЕ озвучивать, держим первую фразу и
    // отдаём поток лишь когда накопилось ≥2 фразы (точно конверсация — преамбула коротка).
    //   - конверсация (нет tool_use): held дофлашиваем в конце, streamedFinal=true (терминал не дублирует);
    //   - tool-ход: held (преамбулу) ОТБРАСЫВАЕМ — финал произнесём в терминале ровно один раз.
    let resp: LlmResponse;
    if (sink && step === 0) {
      const chunker = new SentenceChunker();
      const held: string[] = [];
      let eager = false; // подтверждённый конверсационный режим (≥2 фразы) → немедленная отдача
      const onPiece = (raw: string): void => {
        if (eager) {
          emitSentence(sink, raw);
          spokeAny = true;
          return;
        }
        held.push(raw);
        if (held.length >= 2) {
          for (const h of held) emitSentence(sink, h);
          held.length = 0;
          eager = true;
          spokeAny = true;
        }
      };
      resp = await deps.llm.completeStream(llmReq, (d) => {
        for (const raw of chunker.push(d.text)) onPiece(raw);
      });
      if (resp.toolUses.length === 0) {
        for (const raw of chunker.flush()) onPiece(raw);
        for (const h of held) emitSentence(sink, h); // конверсация в 1 фразу — отдаём её сейчас
        if (held.length > 0) spokeAny = true;
        streamedFinal = true;
      }
      // tool-ход: held + остаток чанкера отбрасываем (преамбулу не озвучиваем).
    } else {
      resp = await deps.llm.complete(llmReq);
    }
    warmth.touch(session.sessionId);
    deps.spend.recordStep(taskId);
    deps.spend.recordUsage(taskId, resp.usage.inputTokens + resp.usage.outputTokens, costUsd(model, resp.usage));
    cacheReadTokens += resp.usage.cacheReadTokens;
    cacheCreationTokens += resp.usage.cacheCreationTokens;
    // Телеметрия: вход/выход за ход (cache_* копятся отдельно выше) + число вызовов инструментов.
    inputTokensTotal += resp.usage.inputTokens;
    outputTokensTotal += resp.usage.outputTokens;
    toolCallsTotal += resp.toolUses.length;

    // H2: аварийный стаб LLM — провал хода. Раньше стаб-текст («Связь прервалась… повторите»)
    // становился finalText → tasks.finish как успех (метрики ok=true), а ход без инструментов ещё и
    // кэшировался семантически → повтор вопроса крутил ошибку ИЗ КЭША уже после восстановления связи
    // («заевшая пластинка»). Терминал ниже честно проваливает задачу и не пишет кэш.
    if (resp.stopReason === "stub") {
      llmStubbed = true;
      if (!spokeAny) streamedFinal = false; // ни фразы не прозвучало — терминал обязан озвучить провал
      // M5: стаб уже прозвучал в sink (step0-стрим отдал его текст пользователю) → терминал ОБЯЗАН
      // вернуть в память/чат ровно этот текст, а не другую фразу «связь прервалась» (иначе запись
      // расходится с произнесённым). Стрим проговорил verbalize(resp.text) пофразно (как штатный
      // конверсационный путь) и выставил streamedFinal — храним ту же вербализованную форму.
      if (spokeAny && streamedFinal) stubSpokenText = verbalize(resp.text);
      break;
    }

    if (resp.toolUses.length === 0) {
      finalText += resp.text;
      // Докрутка обрыва по лимиту вывода: модель упёрлась в max_tokens, не закончив. Продолжаем
      // ровно с места обрыва, а не отдаём огрызок. ТОЛЬКО для не-стримленного хода: голосовой
      // step0 уже произнесён в sink (повтор/двойной голос недопустим) — там берём как есть.
      const streamedThisStep = Boolean(sink) && step === 0;
      if (resp.stopReason === "max_tokens" && !streamedThisStep && continuations < MAX_CONTINUATIONS) {
        continuations += 1;
        convo.push({ role: "assistant", content: resp.text });
        convo.push({
          role: "user",
          content: "Продолжай ровно с места обрыва — без повторов, без преамбул и без финальных фраз, пока не закончишь.",
        });
        log.info("докрутка вывода (max_tokens)", { continuations, of: MAX_CONTINUATIONS });
        continue;
      }
      // Анти-капитуляция: модель закончила ход (end_turn) текстом-отказом, НЕ сделав НИ ОДНОГО вызова
      // инструмента за всю петлю → заставляем попробовать через инструменты, прежде чем принять отказ.
      // Кап=1 + общие потолки (шаги/токены/SpendGuard) исключают runaway. Только end_turn (обрыв по
      // max_tokens уже обработан выше). На голосовом пути озвучка идёт ПОСЛЕ петли (sink=undefined,
      // speakResult) → двойного голоса нет; на синхронном step0-стриме гард ниже не нужен (отказ обычно
      // не стримится тут). looksLikeGiveUp пропускает легитимную отбивку абсурда/опасного.
      // Анти-капитуляция: текст-отказ (looksLikeGiveUp), И при этом НЕ было НИ ОДНОГО успешного инструмента
      // (ноль вызовов ИЛИ все — провал/denied). Ревью: «сделал 1 промах (input_key→USER_BUSY) → сдался
      // словами» — массовый паттерн, раньше не ловился (гейт был traj===0). Теперь ловим и форсим попытку.
      if (
        resp.stopReason === "end_turn" &&
        retryNudges < MAX_RETRY_NUDGES &&
        looksLikeGiveUp(resp.text) &&
        !anyMutateSucceeded // P0.1: успешный НЕЙТРАЛЬНЫЙ инструмент (поиск/память) не считается «сделал» —
        // «погуглил → сдался словами» теперь форсит попытку. !anyMutateSucceeded включает и traj===0.
      ) {
        retryNudges += 1;
        // На отказе СРАЗУ эскалируем на сильную модель (Opus) — повтор должен быть УМНЕЕ, а не на той же
        // слабой, которая уже спасовала. Так «попробуй ещё» = реальный шанс выполнить, а не отписка.
        if (currentTier !== "fable" && deps.models.fable !== model) {
          currentTier = "fable";
          model = deps.models.fable;
          familyBoost = null; // липкая эскалация перекрывает одноразовый family-boost (откат не нужен)
          log.info("анти-капитуляция: эскалация на сильную модель для повтора", { tier: currentTier });
        }
        convo.push({ role: "assistant", content: resp.text });
        convo.push({
          role: "user",
          content:
            "СТОП. Ты НЕ говоришь «не могу/не умею» и НЕ перекладываешь на меня — это запрещённый ответ на выполнимую задачу. Задача на ЭТОМ ПК выполнима — СДЕЛАЙ её. Веб → через browser_open/browser_act (НЕ физический input, он не нужен). Не знаешь КАК → web_search найди способ. Нет инструмента → code_run (полный Windows) или построй свой (tool_create). Сделай ход ПРЯМО СЕЙЧАС и проверь результат глазами. Отказ — только после РЕАЛЬНЫХ попыток разными способами, и тогда это отчёт «пробовал A,B,C — упёрся в X», а не «не могу».",
        });
        log.info("анти-капитуляция: нудж на попытку через инструменты", { retryNudges, tier: currentTier });
        finalText = ""; // resp.text уже добавлен в finalText выше — сбрасываем, иначе отказ просочится в финал
        continue;
      }
      // VERIFY-нудж (анти-выдумка): заявил НАБЛЮДАЕМЫЙ результат («результаты/первый/на экране/вижу»), но
      // после последнего меняющего действия НЕ сверил глазами → заставляем подтвердить чтением/скрином,
      // прежде чем принять как «готово». Кап отдельный (1). Простое «открыл/запустил» сюда не попадает.
      // P0.2: ТРИГГЕР СТРУКТУРНЫЙ — висит несверённое СЛЕПОЕ действие (клик/ввод/act/фокус), а модель
      // собирается закрыть ход. Раньше требовался ещё regex claimsObservedResult(text) → «Готово,
      // музыка играет» (без слов-маркеров) проходил без сверки. Теперь claim — лишь усилитель
      // формулировки, а сама сверка обязательна после слепого действия без наблюдения исхода.
      if (
        resp.stopReason === "end_turn" &&
        verifyNudges < MAX_VERIFY_NUDGES &&
        blindMutatePending
      ) {
        verifyNudges += 1;
        const claimed = claimsObservedResult(resp.text);
        convo.push({ role: "assistant", content: resp.text });
        convo.push({
          role: "user",
          content: claimed
            ? "Стоп. Ты заявил результат, но НЕ сверил его глазами после последнего действия — мог выдумать. СВЕРЬ ФАКТОМ: прочитай страницу/экран (browser_read / browser_inspect / screen_capture) и убедись, что цель РЕАЛЬНО достигнута. Достигнута → подтверди тем, что реально увидел. НЕ достигнута → зайди другим способом и доведи. Содержимое не сочиняй."
            : "Стоп. Ты сделал действие, но НЕ проверил исход — клик/ввод/команда могли не сработать (регион, нет элемента, потерян фокус). Прежде чем сказать «готово», СВЕРЬ РЕАЛЬНЫЙ результат: прочитай страницу/экран (browser_read / browser_inspect / screen_capture). Цель достигнута → подтверди фактом, что увидел. НЕ достигнута → зайди другим способом и доведи, не сдавайся.",
        });
        log.info("verify-петля: нудж на сверку результата глазами", { verifyNudges, claimed });
        finalText = "";
        continue;
      }
      // §адаптация к цели (кап 1, только многошаговые): модель закрывает ход — сверяем с ИСХОДНОЙ
      // задачей. Ловит деградацию цели до подцели: «запусти поиск в доте» при незапущенной Доте →
      // запустил игру → «Готово» (живой случай). Запущенное приложение могло ещё грузиться —
      // нудж прямо говорит подождать и продолжить, а не считать запуск финалом.
      // Усиление (живой случай 2026-07-02): «запусти поиск в доте» → app_launch → screen_capture
      // (меню Доты) → «Дота запущена, сэр» — lastRoundHadVerify ГАСИЛ сверку с целью, хотя модель
      // сверила глазами ПОДЦЕЛЬ (запуск), а не цель (поиск матча). Финал, звучащий как чистый
      // запуск/открытие, проходит goal-check ДАЖЕ после verify-раунда: запуск почти никогда не цель.
      const launchOnlyClaim = /(?<![\p{L}])(запущен|запустил|поднялс|стартовал|открыл)\p{L}*/iu.test(resp.text || "");
      if (resp.stopReason === "end_turn" && !goalCheckDone && round >= 2 && (!lastRoundHadVerify || launchOnlyClaim)) {
        goalCheckDone = true;
        convo.push({ role: "assistant", content: resp.text });
        convo.push({
          role: "user",
          content:
            `Стоп — сверься с ИСХОДНОЙ задачей: «${text}». Выполнена ли она ЦЕЛИКОМ, или сделана только ` +
            `подготовка (запуск/открытие/фокус приложения)? Запущенная программа могла ещё грузиться — ` +
            `подожди её и продолжи до ПОЛНОГО результата. Если цель реально достигнута и сверена глазами — ` +
            `подтверди коротко, ничего не повторяя.`,
        });
        log.info("goal-check: сверка терминала с исходной целью", { round });
        finalText = "";
        continue;
      }
      // Пустой финал после инструментов → один нудж на содержательный ответ (см. emptyFinalNudged).
      if (!finalText && toolTrajectory.length > 0 && !emptyFinalNudged) {
        emptyFinalNudged = true;
        convo.push({ role: "assistant", content: resp.text.trim() || "…" }); // пустой content нельзя (API 400)
        convo.push({
          role: "user",
          content:
            "Ты закрыл ход БЕЗ финальной реплики. Ответь сейчас ОДНИМ содержательным сообщением: сам ответ/итог по исходной задаче (не «Готово» и не пересказ действий).",
        });
        log.info("пустой финал после инструментов — нудж на содержательный ответ");
        continue;
      }
      if (!finalText) finalText = "Готово.";
      break;
    }

    // Пошёл tool-use → это настоящая многошаговая задача: показываем прогресс (§20).
    if (!shown) showStatus();

    // Реплеим ход ассистента (текст + tool_use) и результаты инструментов.
    const assistantBlocks: LlmContentBlock[] = [];
    // extended thinking + tool-use: thinking-блоки ОБЯЗАНЫ идти ПЕРВЫМИ в assistant-ходе (иначе API 400).
    if (resp.thinkingBlocks?.length) assistantBlocks.push(...resp.thinkingBlocks);
    if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
    for (const tu of resp.toolUses) {
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    convo.push({ role: "assistant", content: assistantBlocks });

    const resultBlocks: LlmContentBlock[] = [];
    let sawVerifyThisRound = false; // §адаптация к цели: был ли в раунде успешный verify-инструмент
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
      // §20 чип «по смыслу»: на первом значимом действии переименовываем задачу из сырой фразы
      // в суть («Яндекс Музыка», «Запуск OBS»). emitTaskStatus в конце раунда обновит чип.
      if (!semanticTitleSet) {
        const at = actionTitle(tu.name, tu.input as Record<string, unknown>);
        if (at) {
          task.title = at;
          semanticTitleSet = true;
        }
      }
      // §8: копим траекторию для самообучения; отмечаем успех и уже-сохранённый навык.
      toolTrajectory.push(`${tu.name}${r.isError ? " (ошибка)" : ""}`);
      if (!r.isError) anyToolSucceeded = true;
      // §8 МАКРОС: жесты (фокус/клик/клавиши) с данными актуатора (разрешённые координаты клика) —
      // сырьё для компиляции авто-реплея после успеха задачи.
      if (!r.isError && MACRO_TRACE_TOOLS.has(tu.name)) {
        gestureTrace.push({ name: tu.name, input: tu.input, data: r.data });
      }
      // VERIFY-петля: классифицируем эффект успешного инструмента. Сверка глазами (read/inspect/capture)
      // → verifiedSinceMutate=true. Меняющее действие → didMutate=true и сбрасываем verifiedSinceMutate
      // (значит после него ещё НЕ смотрели). Нейтральные (поиск/память/навыки/load) не трогают флаги.
      if (!r.isError) {
        const eff = toolEffect(tu.name);
        if (eff === "verify") {
          blindMutatePending = false; // сверились глазами — слепое действие подтверждено
          sawVerifyThisRound = true;
        }
        else if (eff === "mutate") {
          anyMutateSucceeded = true; // P0.1: реальное дело сделано (не просто нейтральный поиск)
          // P0.2: слепое действие (клик/ввод/act/фокус) → исход неизвестен, требуется сверка перед «готово».
          // Самоподтверждающийся mutate (code_run/fs/office/system/launch/open) флаг НЕ ставит.
          if (isBlindMutate(tu.name)) blindMutatePending = true;
        }
      }
      if (tu.name === "skill_save" && !r.isError) {
        skillSavedInLoop = true;
        savedSkillId = (r.data as { id?: string } | undefined)?.id ?? savedSkillId; // §8 МАКРОС
      }
      if ((tu.name === "web_search" || tu.name === "web_fetch") && !r.isError) wasResearched = true;
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      });
    }
    // Инвариант Anthropic: на КАЖДЫЙ tool_use ОБЯЗАТЕЛЕН парный tool_result. Ранний break по отмене
    // (выше) мог оставить часть tool_use без результата → дозаполняем заглушкой-ошибкой, иначе любой
    // путь, отправляющий этот convo дальше, упрётся в HTTP 400. Делаем инвариант безусловным.
    const answered = new Set(resultBlocks.map((b) => (b.type === "tool_result" ? b.tool_use_id : "")));
    for (const tu of resp.toolUses) {
      if (!answered.has(tu.id)) {
        resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: "отменено пользователем", is_error: true });
      }
    }
    convo.push({ role: "user", content: resultBlocks });
    // §адаптация к цели: помним, была ли в ПОСЛЕДНЕМ инструментальном раунде сверка глазами.
    if (resp.toolUses.length > 0) lastRoundHadVerify = sawVerifyThisRound;

    // §скорость (зрение): старые скрины — вон из контекста (см. prune-images.ts: токены, TTFT, кеш).
    const prunedImages = pruneStaleImages(convo, KEEP_SCREENSHOTS);
    if (prunedImages > 0) log.debug("зрение: устаревшие скрины вырезаны из контекста", { pruned: prunedImages });

    // §трейдинг: задача коснулась БИРЖЕВОГО инструмента → дальше только МАКС модель (Opus), без тиров
    // (требование: на биржах важна обдуманность). Страховка к роутеру (looksLikeTrading): ловит случаи,
    // где запрос не выглядел биржевым, но привёл к рыночному/торговому инструменту.
    if (currentTier !== "fable" && resp.toolUses.some((t) => TRADING_TOOLS.has(t.name)) && deps.models.fable !== model) {
      log.info("§трейдинг: эскалация на макс модель (Opus) — биржевой инструмент в ходе", { from: currentTier });
      currentTier = "fable";
      model = deps.models.fable;
      familyBoost = null; // липкая эскалация перекрывает одноразовый family-boost
    }

    // Эскалация тира (§7): если раунд провалился ЦЕЛИКОМ (все инструменты вернули ошибку)
    // ESCALATE_AFTER раз подряд — модель застряла → заходим сильнее (haiku→sonnet→fable),
    // вместо того чтобы сдаться на слабой модели. Один успешный инструмент сбрасывает счётчик.
    const allErrored =
      resultBlocks.length > 0 && resultBlocks.every((b) => b.type === "tool_result" && b.is_error === true);
    if (allErrored) {
      consecErrorRounds += 1;
      if (consecErrorRounds >= ESCALATE_AFTER && currentTier !== "fable") {
        // аннотация обязательна: вывод типа зацикливается через back-edge петли (currentTier = nextTier)
        const nextTier: Exclude<Tier, "tier0"> = currentTier === "haiku" ? "sonnet" : "fable";
        const nextModel = deps.models[nextTier];
        if (nextModel !== model) {
          // Реальная эскалация: целевой тир — ДРУГАЯ модель → есть смысл «зайти сильнее».
          currentTier = nextTier;
          model = nextModel;
          consecErrorRounds = 0;
          familyBoost = null; // липкая эскалация перекрывает одноразовый family-boost
          log.info("эскалация тира: модель застряла — захожу сильнее", { to: currentTier, model });
          // Filler: дать понять, что не зависли, а пробуем иначе (а не молчать на застревании).
          session.send("transcript", { text: "Секунду, зайду с другой стороны.", final: true });
        } else {
          // Холостая эскалация: все тиры на ОДНОЙ модели (тек. конфиг — везде Opus) — «заходить
          // сильнее» некуда, та же модель не станет умнее. НЕ жжём раунды на мнимый перезаход и НЕ
          // врём «зайду иначе»; помечаем fable, чтобы дальше не пытаться эскалировать вхолостую.
          currentTier = "fable";
          familyBoost = null; // маркер «эскалировать некуда» тоже липкий — откат его не снимает
          log.info("эскалация пропущена: целевой тир — та же модель (нет более сильной)", { model });
        }
      }
    } else {
      consecErrorRounds = 0;
    }

    // Anti-runaway (§20): модель повторяет ТОТ ЖЕ УСПЕШНЫЙ tool-вызов раунд за раундом
    // («открывает до посинения», карточка задачи не закрывается). H4 (ревью 2026-07-02): такой повтор —
    // типичный признак, что цель НЕ достигается, поэтому прежний обрыв с дефолтом «Готово, сэр.» был
    // ложным успехом в обход verify-петли. Теперь: на 3-м одинаковом — ОДИН интервент-нудж (сверь
    // глазами / смени подход), при упорстве — честный обрыв С ПРОВАЛОМ (терминал runawayStuck).
    // Падающие повторы НЕ трогаем (ими занимается эскалация тира выше); разный input — сброс.
    const toolSig = resp.toolUses.map((t) => `${t.name}:${JSON.stringify(t.input)}`).join("|");
    if (toolSig === lastToolSig && !allErrored) {
      identicalRepeats += 1;
      if (identicalRepeats >= 2) {
        if (!repeatNudged) {
          repeatNudged = true;
          const nudge =
            "СТОП. Ты повторяешь ОДНО И ТО ЖЕ действие с тем же вводом — значит, цель, скорее всего, НЕ достигается. НЕ повторяй его снова. Сверь реальное состояние глазами (browser_read / screen_capture): цель достигнута → заверши и подтверди фактом; НЕ достигнута → смени подход (другой инструмент / другой путь).";
          // Как family-нудж: дописываем text-блок в ТЕКУЩЕЕ user-сообщение с tool_result.
          const last = convo[convo.length - 1];
          if (last && last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text: nudge });
          else convo.push({ role: "user", content: nudge });
          log.warn("anti-runaway: повтор одинакового действия — нудж на сверку/смену подхода", { tool: toolSig.slice(0, 80) });
        } else {
          log.warn("повтор одного успешного действия после нуджа — обрыв петли (честный провал)", { tool: toolSig.slice(0, 80) });
          runawayStuck = true;
          break;
        }
      }
    } else {
      identicalRepeats = 0;
    }
    lastToolSig = toolSig;

    // Мягкий anti-runaway по СЕМЕЙСТВУ инструментов (фикс «дублирует команды»): один tool NAME вызван
    // слишком много раз за задачу → флуд без сходимости. Сначала интервент-нудж (смени подход / оцени, не
    // достигнута ли цель) + эскалация на Opus; при упорстве — честный обрыв ДО упора в max_steps(50).
    for (const tu of resp.toolUses) toolNameCount.set(tu.name, (toolNameCount.get(tu.name) ?? 0) + 1);
    const worst = [...toolNameCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= FAMILY_SOFT_CAP * (familyNudges + 1)) {
      if (familyNudges < MAX_FAMILY_NUDGES) {
        familyNudges += 1;
        const nudge =
          `СТОП. Ты вызвал «${worst[0]}» ${worst[1]} раз — похоже на топтание на месте без результата. ОЦЕНИ ТРЕЗВО: цель УЖЕ достигнута? Тогда заверши и подтверди фактом. Если НЕТ — повтор того же НЕ помогает: СМЕНИ подход (другой инструмент / прямой URL / code_run / прочитай реальное состояние и действуй точечно), не долби одно и то же.`;
        // Добавляем как text-блок в ТЕКУЩЕЕ user-сообщение с tool_result (не плодим второй user-ход).
        const last = convo[convo.length - 1];
        if (last && last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text: nudge });
        else convo.push({ role: "user", content: nudge });
        log.warn("anti-runaway (семейство): интервент-нудж — смени подход", { tool: worst[0], count: worst[1], familyNudges });
        if (currentTier !== "fable" && deps.models.fable !== model) {
          // §скорость: усиление ОДНОРАЗОВОЕ — 1 раунд переосмысления на сильной модели, затем
          // откат (см. familyBoost в шапке петли). Липкий Opus замедлял всю оставшуюся механику.
          familyBoost = { tier: currentTier, model, roundsLeft: 1 };
          currentTier = "fable";
          model = deps.models.fable; // на переосмыслении — сильная модель
        }
      } else {
        log.warn("anti-runaway (семейство): обрыв петли — флуд не остановился", { tool: worst[0], count: worst[1] });
        finalText = resp.text?.trim() || `Застрял на «${worst[0]}» — не довёл, нужен другой путь. Скажите, как лучше.`;
        break;
      }
    }

    round += 1;
    tasks.progress(taskId, round);
    if (shown) emitTaskStatus(session, task);
  }
  } catch (e) {
    log.error("agent-loop: исключение в петле", { error: e instanceof Error ? e.message : String(e) });
    failed = true;
  } finally {
    // §20: отложенный ack не должен пережить петлю (терминал сам скажет итог).
    if (ackTimer) clearTimeout(ackTimer);
    // Освобождаем аренду ввода на ЛЮБОМ выходе (успех/отмена/лимит/исключение, §20),
    // иначе следующая задача навечно зависнет на acquire. Терминал ниже ввод не трогает.
    if (holdsInput && arbiter) arbiter.release();
  }

  // §8 HERMES самообучение: задача решена САМА (успешно), готового навыка не было (recalled===null)
  // и сам не сохранил по ходу → один бэкстоп-ход предлагает сохранить приём навыком. Узкий набор
  // (только skill_save/skill_list) — рефлексия не делает реальных действий. Триггер: многошагово
  // (round≥3) ИЛИ Джарвис сам НАШЁЛ способ в вебе (wasResearched, даже за 1-2 шага — иначе будет
  // гуглить то же заново; ровно жалоба владельца «должен искать и запоминать»).
  const learnWorthy = round >= 3 || (wasResearched && round >= 1);
  if (!failed && !limited && !cancelled && !timedOut && !llmStubbed && !runawayStuck && finalText && anyToolSucceeded && learnWorthy && !recalled && !skillSavedInLoop && deps.skills) {
    const learnedId = await selfLearnSkill({
      deps,
      sys,
      convo,
      finalText,
      round,
      toolTrajectory,
      toolCtx,
      // Само-обучение — КЛЮЧЕВАЯ способность Джарвиса, и качество выученной процедуры
      // компаундится: плохой навык отравит recall на будущие задачи. Операция редкая
      // (только после успешной многошаговой задачи, round≥3), поэтому синтезируем навык на
      // СИЛЬНОМ тире — не экономим. Учиться надо умно, а не «как дешёвая модель».
      tier: "fable",
      model: deps.models.fable,
      taskId,
      wasResearched,
    }).catch((e) => {
      log.debug("self-learn навыка пропущен", e instanceof Error ? e.message : String(e));
      return null;
    });
    if (learnedId) savedSkillId = learnedId; // §8 МАКРОС: реплей допишется в свежевыученный навык
  }

  deps.spend.finishTask(taskId);
  if (cacheReadTokens + cacheCreationTokens > 0) {
    log.info("prompt-кеш (§15)", { cacheReadTokens, cacheCreationTokens });
  }

  // §ErrorVoice: ложное «Готово» при сплошном провале инструментов — считаем ошибкой и для телеметрии
  // (вычисляем здесь, ниже переиспользуем в терминале). См. анти-ложное-«Готово» ниже.
  // P0.1: masked-failure по anyMutateSucceeded (не anyToolSucceeded) — пустое «Готово» после одних лишь
  // нейтральных вызовов (web_search и т.п.) тоже ложный успех: дело (мутация) не сделано.
  // НО не на ВОПРОСЕ (conversational): там «дела» (mutate) не ожидается вовсе, и «Не вышло — действие
  // не сработало» на невинный вопрос — ложь в обратную сторону (живой смоук 2026-07-02: «сколько будет
  // 2+2» + tool_load → пустой финал → «Не вышло»). Вопрос с полым финалом лечится emptyFinalNudged выше.
  const maskedFailure =
    opts?.conversational !== true && toolTrajectory.length > 0 && !anyMutateSucceeded && isHollowSuccess(finalText || "");

  // ПРОД-ТЕЛЕМЕТРИЯ (obs/metrics): per-task событие — токены/стоимость/латентность/раунды/тир/успех.
  // ok=false на любом неуспехе (исключение/лимит/таймаут/отмена/маскированный провал). Запись + одна
  // читаемая лог-строка «task-метрики» — чтобы видеть стоимость и латентность задачи в логах.
  const taskUsage = {
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
    cacheReadTokens,
    cacheCreationTokens,
  };
  // H2/H4: стаб LLM и топтание на одном действии — тоже НЕ успех (метрики ok=false, макрос не пишем).
  const taskOk = !failed && !limited && !timedOut && !cancelled && !maskedFailure && !llmStubbed && !runawayStuck;
  const latencyMs = Date.now() - loopStartMs;

  // P2.3 НАДЁЖНОСТЬ НАВЫКА: задача шла с recall'нутым выученным навыком → записываем исход. Провал копит
  // fail_count (навык перестанет подсовываться recall'ом), успех гасит. ТОЛЬКО СВОЙ навык (общую надёжность
  // не трогаем — это админ-решение §мультитенант). Отмену/лимит/таймаут НЕ считаем провалом навыка (не его
  // вина) — учитываем лишь реальный исход (успех / failed / маскированный провал).
  // H2: стаб LLM — не вина навыка, исход не записываем (иначе сетевой блип копит fail_count).
  if (recalled && !recalled.fromShared && deps.skills?.recordOutcome && !cancelled && !limited && !timedOut && !llmStubbed) {
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
  const macroTargetId = recalled && !recalled.fromShared ? recalled.id : savedSkillId;
  if (taskOk && macroTargetId && deps.skills?.attachReplay && gestureTrace.length > 0) {
    const lines = compileReplayLines(gestureTrace);
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
    tier: currentTier,
    model,
    userId: deps.userId,
    latencyMs,
    rounds: round,
    toolCalls: toolCallsTotal,
    usage: taskUsage,
    ok: taskOk,
  });
  log.info("task-метрики", {
    tier: currentTier,
    latencyMs,
    rounds: round,
    toolCalls: toolCallsTotal,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: Number(estimateCostUsd(taskUsage, model).toFixed(6)),
    ok: taskOk,
  });

  // §10 realtime: финальная реплика терминала в sink (если ещё не стримилась пофразно на
  // 1-м ходе). voice уже вербализован — режем на предложения для пофразного синтеза. На
  // конверсационном пути (streamedFinal) реплика уже отдана → не дублируем.
  const terminal = (voice: string): AgentReply => {
    if (sink && !streamedFinal) for (const s of splitIntoSentences(voice)) sink.sentence(s);
    return { voice };
  };

  // Терминал задачи (§20): отмена / лимит / успех — со стримом task.status.
  if (cancelled) {
    // state уже "cancelled" (выставил router через tasks.cancel/cancelSession) — досылаем финальный статус.
    if (shown) emitTaskStatus(session, task);
    // ТИХО (аудит 2026-07-02): ack отмены («Остановил.»/«Остановил все, сэр.») уже произносит
    // handleTaskControl ОДИН раз на всю команду. Раньше КАЖДАЯ отменённая фоновая петля ещё и
    // возвращала «Хорошо, остановил.» → speakResult → на двух задачах звучало дважды (живой случай:
    // «продолжи/продолжу видео на ютубе» → две петли → «Хорошо, остановил.» ×2). Терминал молчит.
    return terminal("");
  }
  if (failed) {
    tasks.fail(taskId, "ошибка выполнения задачи");
    if (shown) emitTaskStatus(session, task);
    // Если часть ответа уже прозвучала — не противоречим «не смог», а мягко обозначаем заминку.
    return terminal(verbalize(spokeAny ? "…на этом застопорился, сэр." : "Не смог выполнить — произошла ошибка."));
  }
  if (limited) {
    tasks.fail(taskId, "достигнут лимит на задачу (spend cap §14)");
    if (shown) emitTaskStatus(session, task);
    return terminal(verbalize(spokeAny ? "…дальше остановился — достигнут лимит." : "Остановился — достигнут лимит на задачу."));
  }
  if (timedOut) {
    tasks.fail(taskId, "превышен потолок времени задачи");
    if (shown) emitTaskStatus(session, task);
    return terminal(verbalize(spokeAny ? "…дальше затянулось, остановил." : "Долго не отвечало — остановил. Повторить?"));
  }
  // H2: LLM недоступен (аварийный стаб) — честный офлайн-провал: НЕ finish, НЕ кэш, ok=false.
  if (llmStubbed) {
    tasks.fail(taskId, "LLM недоступен (аварийный стаб)");
    if (shown) emitTaskStatus(session, task);
    // M5: стаб УЖЕ прозвучал в sink → память/чат обязаны совпасть с произнесённым. Возвращаем ровно
    // тот текст, что прозвучал (не перезаписываем другой фразой). terminal() при streamedFinal в sink
    // повторно не отдаёт — двойного голоса нет.
    if (stubSpokenText) return terminal(stubSpokenText);
    return terminal(verbalize(spokeAny
      ? "…и тут связь с сервером прервалась, сэр. Повторите чуть позже."
      : "Связь с сервером прервалась, сэр. Повторите, пожалуйста."));
  }
  // H4: топтание на одном действии без результата — честный провал, а не «Готово».
  if (runawayStuck) {
    tasks.fail(taskId, "повтор одного действия без видимого результата");
    if (shown) emitTaskStatus(session, task);
    return terminal(verbalize(spokeAny
      ? "…крутился на одном действии без видимого результата — остановился, сэр. Могу зайти иначе."
      : "Не уверен, что вышло, сэр: действие повторялось без видимого результата. Остановился — скажите, зайти другим способом?"));
  }
  // §ErrorVoice анти-ложное-«Готово»: модель закрыла ход, но ВСЕ инструменты пали
  // (anyToolSucceeded=false при бывших попытках) и финал — пустое подтверждение → честно говорим о
  // провале, а не «Готово» на сбое. Содержательный ответ модели (не «Готово») не трогаем — доверяем.
  // (maskedFailure вычислен выше — рядом с телеметрией.)
  if (maskedFailure) {
    tasks.fail(taskId, "инструменты не отработали");
    if (shown) emitTaskStatus(session, task);
    log.info("§ErrorVoice: провал озвучен честно (ложное «Готово» перехвачено)", { trajectory: toolTrajectory });
    return terminal(verbalize(maskedFailureReply(spokeAny)));
  }
  if (!finalText) finalText = "Готово.";
  tasks.finish(taskId, finalText);
  if (shown) emitTaskStatus(session, task);
  const spokenFinal = verbalize(finalText);
  // §15 семантический кэш: запоминаем ТОЛЬКО чисто-вербальный ход (НИ ОДНОГО инструмента → нет
  // побочных эффектов, реплей не соврёт «сделано»). store сам отсекает непригодные/командные запросы
  // (isCacheableQuery). Fire-and-forget — эмбеддинг async, не задерживает ответ.
  if (deps.responseCache && toolTrajectory.length === 0) {
    void deps.responseCache.store(deps.userId, text, spokenFinal);
  }
  return terminal(spokenFinal);
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
    title: task.title,
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
  openOrFocus?: (url: string) => Promise<unknown>,
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
      return { kind: "browser.open", url: intent.url, ...(intent.inDefault ? { inDefault: true } : {}) };
    case "media":
      return { kind: "system.media", op: intent.op };
    case "volume":
      return { kind: "system.volume", op: intent.op, ...(intent.level !== undefined ? { level: intent.level } : {}) };
    case "clarify":
      throw new Error("clarify не превращается в ActionCommand (обрабатывается в handleUserText)");
  }
}

/**
 * Грубая оценка стоимости вызова (для spend cap §14). Порядок величины в
 * нормализованных единицах: вход=1, кеш-чтение=0.1, кеш-запись=1.25, выход=5 —
 * отражает экономию prompt-кеша (§15).
 */
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
    // §мультитенант: честная формулировка — общий приём из библиотеки vs собственный прошлый.
    s.fromShared ? "Процедура (проверенный приём из общей библиотеки):" : "Процедура (твой прошлый успешный приём):",
    s.procedure,
    "",
    // §8: навык — это команда-ДЕЙСТВИЕ. Раньше «следуй гибко… не подходит — игнорируй» давало лазейку
    // ответить болтовнёй вместо исполнения (наблюдённый баг с Дотой). Теперь обязываем ДЕЙСТВОВАТЬ
    // инструментами и проверять глазами; ветку «не подходит» сохраняем (recall лексический, не идеален).
    "Это команда-ДЕЙСТВИЕ: ИСПОЛНИ навык инструментами в ЭТОМ ходе (а не перескажи словами). " +
      "Следуй шагам гибко, но ОБЯЗАТЕЛЬНО вызови нужные инструменты и проверь исход глазами " +
      "(screen_capture/browser_read). Если навык к этой задаче явно не подходит — реши задачу " +
      "инструментами по-своему, но всё равно ДЕЙСТВУЙ, не отвечай одной болтовнёй.",
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
  wasResearched: boolean;
}): Promise<string | null> {
  const { deps, sys, convo, finalText, round, toolTrajectory, toolCtx, tier, model, taskId, wasResearched } = args;
  const trajectory = toolTrajectory.length > 0 ? toolTrajectory.join(" → ") : "—";
  const nudge =
    `[самообучение §8] Задача решена за ${round} шагов` +
    (wasResearched
      ? " — причём способ ты НАШЁЛ сам через web_search/web_fetch. Это и есть самый ценный навык: "
      : ", готового навыка не было. ") +
    "СОХРАНИ приём одним вызовом skill_save({name, when, procedure}), если он пригодится для похожих " +
    "задач: описывай обобщённо (без разовых значений этой задачи), procedure — шаги по порядку + " +
    "грабли + как проверить результат. " +
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
        return null;
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
      deps.spend.recordUsage(reflectId, resp.usage.inputTokens + resp.usage.outputTokens, costUsd(model, resp.usage));

      if (resp.toolUses.length === 0) return null; // модель решила не сохранять — это нормально

      const assistantBlocks: LlmContentBlock[] = [];
      if (resp.thinkingBlocks?.length) assistantBlocks.push(...resp.thinkingBlocks); // thinking ПЕРВЫМИ (req. API)
      if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
      for (const tu of resp.toolUses) {
        assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      reflectConvo.push({ role: "assistant", content: assistantBlocks });

      const resultBlocks: LlmContentBlock[] = [];
      let saved = false;
      let savedId: string | null = null;
      for (const tu of resp.toolUses) {
        const r = await dispatchTool(tu.name, tu.input, toolCtx);
        resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError });
        if (tu.name === "skill_save" && !r.isError) {
          saved = true;
          savedId = (r.data as { id?: string } | undefined)?.id ?? null; // §8 МАКРОС: id для дозаписи реплея
        }
      }
      reflectConvo.push({ role: "user", content: resultBlocks });
      if (saved) {
        log.info("самообучение: навык сохранён после задачи (§8)");
        return savedId;
      }
    }
  } finally {
    deps.spend.finishTask(reflectId); // не копим счётчики ephemeral-метра рефлексии
  }
  return null;
}
