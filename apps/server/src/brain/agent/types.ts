// W3 «Петля»: контракты агента (ответ, sink стрима, зависимости) — вынесены из agent/index.ts дословно.
import type { Task } from "../tasks/task.js";
import type { TaskCheckpoint } from "./checkpoint.js";
import { type AsyncMutex, type Semaphore, type ThinkingEffort, type Tier } from "@jarvis/shared";
import type { McpManager } from "../mcp/manager.js";
import type { ILlmProvider } from "../../integrations/llm.js";
import { type SelectionSlot } from "./selection-context.js";
import type { AppUsage, MatchedChannel } from "../app-channels.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { IWebProvider } from "../../integrations/web.js";
import { type EpisodicMemory } from "../../memory/episodic.js";
import type { IEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import type { WorkingMemory } from "../../memory/working.js";
import type { SpendGuard } from "../../billing/index.js";
import { type UserContextSlot } from "../persona/index.js";
import { cap } from "../verbalize/action-phrases.js";
import type { DynamicToolStore } from "../tools/dynamic.js";
import type { SkillProvider } from "../../memory/skills.js";
import type { TradingService } from "../trading/index.js";
import type { KnowledgeBase } from "../knowledge/index.js";
import type { SemanticResponseCache } from "../response-cache.js";
import { TaskManager } from "../tasks/manager.js";
import type { ReminderService } from "../../proactive/reminders/service.js";
import type { WatchService } from "../../proactive/watch/service.js";
import type { ObligationStore } from "../../proactive/ambient/obligations.js";
import type { ActivityService } from "../activities.js";
import type { ResolutionMemory } from "../../memory/resolution-memory.js";
import { SessionWarmth } from "./warmth.js";
import { costUsd } from "../../obs/pricing.js";

/** Ответ агента по схеме §21. */
export interface AgentReply {
  voice: string;
  display?: { title?: string; markdown: string };
  /**
   * tier0 app.launch не нашёл цель (сценарии 2026-09-02, причина №1): «запусти тесты»/«включи стрим» с
   * НЕизвестным именем умирали честным «не нашёл» без шанса для модели. Флаг — внутренний: handleUserText
   * на инлайн-пути отдаёт реплику модели вместо терминала; фоновые/промотированные пути озвучивают voice как есть.
   */
  fallbackToLlm?: true;
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
  /**
   * Реплика сгенерирована целиком (full — весь голос для транскрипта/памяти). origin "proactive" — служебная фраза
   * (ack промоушена «Берусь, сэр»): окно разговора она НЕ открывает и не продлевает (ревью 2026-09-24, T-F6/B-F1 —
   * иначе на каждой фоновой задаче 8 с всё, что звучит в комнате, принималось за команду).
   */
  done(full: string, opts?: { origin?: "user-turn" | "proactive" }): void;
}

/** Зависимости агента (инъекция для тестируемости и разделения слоёв). */
/** Событие расхода одного вызова LLM для ledger продукта (см. AgentDeps.usageSink). */
export interface UsageSinkEvent {
  taskId: string;
  /** Раунд петли (у префилла/рефлексии — undefined). */
  round?: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  /** Стоимость по obs/pricing в USD (0 у хода по подписке). */
  costUsd: number;
  kind: "turn" | "prefill" | "reflect";
  channel: "api" | "subscription";
  /** Ответ — аварийный стаб без вызова API: расхода нет, строку ledger не писать. */
  stubbed?: boolean;
  /** Размер промпта (watermark прошлого usage) — оценка стоимости, если стрим оборвался до usage-события. */
  promptTokensEstimate?: number;
}

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
  /**
   * ПРОДУКТОВЫЙ РЕЖИМ (2026-09-02): честный текст терминала при исчерпании квоты ТАРИФА (spend_cap из
   * плана) — «кредиты исчерпаны, продлите/добавьте ключ», а не «достигнут лимит» владельца. Отсутствует
   * при мастер-флаге 0 → прежняя формулировка байт-в-байт.
   */
  quotaExhaustedText?: string;
  /** Продуктовый режим: self_*-инструменты (телеметрия и исходники машины владельца) арендатору закрыты. */
  productMode?: boolean;
  /**
   * ПРОДУКТОВЫЙ РЕЖИМ: приёмник расхода per вызов LLM (ledger в микро-долларах). Зовётся на КАЖДОМ платном
   * вызове петли (раунд, префилл, рефлексия самообучения) — ровно там, где `spend.recordUsage`. При
   * мастер-флаге 0 отсутствует → ни одной новой записи.
   */
  usageSink?: (e: UsageSinkEvent) => void;
  userId: string;
  /** §15 семантический кэш чисто-вербальных ответов (опц.) — пропуск LLM на близком фактическом повторе. */
  responseCache?: SemanticResponseCache;
  /**
   * Эмбеддер (e5) для семантического слоя дубль-гейта §20 (Волна 1, эпизод 2026-07-10): STT-обрывок
   * повтора («в dot'е.»), который лексический гейт не поймал, сверяется косинусом с целями активных
   * задач. Опционален: нет/сбой/таймаут → работает только лексический слой (честная деградация).
   */
  embedder?: IEmbeddingProvider;
  /**
   * Волна 1: мгновенная СЛЫШИМАЯ приёмка фоновой задачи (earcon-тон, не фраза). Зовётся в момент
   * ухода задачи в фон — пользователь сразу знает «услышал, делаю», не повторяет команду в тишину.
   */
  taskAccepted?: () => void;
  userContext?: UserContextSlot;
  /**
   * §режим выделения (2026-09-03): слот с областью, которую владелец обвёл на экране. Живёт в
   * session.scoped (переживает пересоздание agentDeps на реконнекте — идущая петля читает живое
   * состояние), а в промпт идёт не структура, а строка с ВОЗРАСТОМ указания, посчитанным в момент
   * сборки. Нет слота / слот пуст = владелец сейчас ни на что не показывает.
   */
  selection?: SelectionSlot;
  /** §режим выделения: какая горячая клавиша РЕАЛЬНО зарегистрирована у клиента (null/undefined — никакая). */
  selectionHotkey?: string | null;
  /**
   * Реестр программных каналов установленных приложений (2026-09-01): «у этой программы есть
   * API/CLI/протокол — не кликай». Наполняется из client.env; в промпт идёт ОДНОЙ строкой паспорта,
   * подробности модель берёт инструментом app_channels.
   */
  appChannels?: MatchedChannel[];
  /**
   * 2026-09-24 (ревью T-F1): ход из DEV-сессии (текст-драйвер/смоук/QA, см. gateway/dev-session.ts). Такая сессия
   * работает на СВОЕЙ рабочей памяти (не грузит и не пишет память владельца), её задачи не попадают в «что я сделал»
   * и на диск, она не учит навыки, не кредитует их исходом, не пишет в долговременную память и не запускает рефлексы.
   * 09.09 реплика драйвера «выруби музыку» осела в памяти владельца, и через час на «ты меня слышишь?» Джарвис
   * поставил его видео на паузу.
   */
  devSession?: boolean;
  /** W4.2: минуты фокуса по процессу с клиента (client.env.usage) — порядок реестра каналов и честное «у частой программы канала нет». */
  appUsage?: AppUsage[];
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
  /**
   * Волна C (P0 #4): чекпойнты ПРЕРВАННЫХ задач — «продолжи с того же места» становится правдой.
   * Общий с gateway (durable, переживает рестарт). Не передан → фича выключена: терминал прерывания
   * тогда НЕ обещает продолжение (обещать то, чего нет, — нарушение честности).
   */
  checkpoints?: CheckpointStore;
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
    tabRead(url?: string, tabId?: number, query?: string): Promise<unknown>;
    tabInspect(url?: string, query?: string, cap?: number, tabId?: number, refMode?: boolean): Promise<unknown>;
    tabAct(url: string, intent: string, params?: Record<string, unknown>, tabId?: number, refMode?: boolean): Promise<unknown>;
    tabBatch?(url: string, steps: unknown[], tabId?: number, refMode?: boolean): Promise<unknown>;
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
  /** Фоновые активности (2026-07-25): чип живёт, пока идёт работа ПОСЛЕ хода (автолистание Shorts). */
  activities?: ActivityService;
  /** Волна E: паспорт возможностей — готовый блок «что реально доступно сейчас» (renderCapabilityPassport). */
  capabilities?: () => string;
  /** Опытная память резолва получателей (§ скорость): «помню, как зарезолвил». Общий с gateway. */
  resolutionMemory?: ResolutionMemory;
  /**
   * Канал озвучки РЕЗУЛЬТАТА фоновой задачи (§20 async). Если задан — многошаговые
   * задачи исполняются в фоне (не блокируя разговор), а итог проговаривается сюда.
   * Без него (тесты/dev.text) — синхронное поведение.
   */
  speakResult?: (reply: AgentReply, opts?: { origin?: "user-turn" | "proactive" }) => void;
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

/** Опции одного прогона петли (runAgentLoop). */
export interface LoopOpts {
  freshContext?: boolean;
  conversational?: boolean;
  /** Ревью 2026-09-24 (T-F6): ход — короткая реакция («нет, не надо», «хорошо»): ответ в кэш ответов не кладётся
   *  (он зависит от предыдущей реплики, а кэш — от текста). */
  reaction?: boolean;
  smalltalk?: boolean;
  suppressStepStream?: boolean;
  viaWake?: boolean;
  /** W0: задача, созданная ДО ожидания семафора (state queued) — иначе в очереди её не видят «отмени»/дубль-гейт. */
  preTask?: Task;
  /** Волна C: продолжаем ПРЕРВАННУЮ задачу — журнал прошлого захода уходит хвостом в convo. */
  resumeFrom?: TaskCheckpoint;
  /** Машинный реэнтри (watch-action), не речь владельца: чекпойнт не пишем (см. saveCheckpoint). */
  machine?: boolean;
  /**
   * §режим выделения (контроль-3): выделение было активно НА СТАРТЕ хода. Гейт store читал слот в
   * КОНЦЕ хода — выделение, снятое пока модель отвечала, пропускало в кэш дейктический ответ
   * («вы показываете на область 640×360»), который потом всплывал без всякой рамки.
   */
  selectionAtStart?: boolean;
}
