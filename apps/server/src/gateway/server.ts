/**
 * Gateway — Fastify + WebSocket-хаб (§4, §5).
 *
 * Жизненный цикл соединения:
 *   1. Клиент коннектится на /ws.
 *   2. Сервер ждёт первый кадр client.hello (с таймаутом handshake).
 *   3. Валидирует protocolVersion через isProtocolCompatible. Несовпадение →
 *      error "version_mismatch" + закрыть (§5: рассинхрон громкий, не тихий).
 *   4. Создаёт/возобновляет сессию (resume по resumeSessionId), шлёт server.hello.
 *   5. Запускает heartbeat. Дальше все кадры идут в router-ws.dispatch.
 *
 * Это реально работающий код M0/M2-среза.
 */
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import {
  type Envelope,
  type Hello,
  type ProtocolError,
  isEnvelope,
  isProtocolCompatible,
} from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { ServerConfig } from "../config.js";
import { SpendGuards } from "../billing/index.js";
import { metrics } from "../obs/metrics.js";
import { type FileLogSink, initFileLog } from "../obs/file-log.js";
import { SessionWarmth } from "../brain/agent/warmth.js";
import { flushTaskStores, loadTaskManager } from "../brain/tasks/task-store.js";
import { flushResolutionStores, loadResolutionMemory } from "../memory/resolution-memory.js";
import { flushWorkingStores } from "../memory/working-store.js";
import { DynamicToolStore } from "../brain/tools/dynamic.js";
import { McpManager } from "../brain/mcp/manager.js";
import { loadMcpConfig } from "../brain/mcp/config.js";
import { TOOLS_BY_NAME } from "@jarvis/tools";
import { AnthropicLlmProvider } from "../integrations/anthropic.js";
import { getProfile, loadProfile } from "../brain/profile.js";
import { ReminderService } from "../proactive/reminders/service.js";
import { createWatchChecker } from "../proactive/watch/checker.js";
import { WatchService } from "../proactive/watch/service.js";
import { AmbientEngine } from "../proactive/ambient/engine.js";
import { AmbientSeenStore } from "../proactive/ambient/store.js";
import { ObligationStore, createObligationsSource } from "../proactive/ambient/obligations.js";
import { createTelegramSource } from "../proactive/ambient/telegram-source.js";
import { VoiceProfileStore } from "../voice/speaker/store.js";
import { createSpeakerVerifier } from "../voice/speaker/sherpa-verifier.js";
import { createSpeakerVerifierSidecar } from "../voice/speaker/verifier-sidecar.js";
import { loadConsent } from "../brain/consent.js";
import {
  CachingEmbeddingProvider,
  OpenAiEmbeddingProvider,
} from "../integrations/openai-embeddings.js";
import { LocalEmbeddingProvider } from "../integrations/local-embeddings.js";
import { SemanticResponseCache } from "../brain/response-cache.js";
import { createSttProvider, createTtsProvider } from "../integrations/providers.js";
import { CachingTtsProvider } from "../integrations/tts-cache.js";
import { FillerCache } from "../voice/filler-cache.js";
import { CachingWebProvider, WebProvider } from "../integrations/web.js";
import { AutoPredictor, MarketDataProvider, TradeExpert, TradingService, autoPredictorConfigFromEnv, loadPredictionStore, makeTinkoffProvider } from "../brain/trading/index.js";
import { KnowledgeBase } from "../brain/knowledge/index.js";
import { createEpisodicMemory } from "../memory/episodic.js";
import { SHARED_USER_ID, type SkillDistiller, createSkillProvider, seedSharedSkills } from "../memory/skills.js";
import { SHARED_SKILL_SEED } from "../seed/shared-skills.js";
import { ensureUser } from "../db/users.js";
import { forgetClientContext } from "../proactive/salience.js";
import { DEV_USER, resolveAndProvision } from "./identity.js";
import { isLoopbackHost, resolveBindHost } from "./bind.js";
import { buildGreeting } from "../proactive/greeting.js";
import { ExtensionBridge, type ExtSocket } from "./extension-bridge.js";
import { startHeartbeat } from "./heartbeat.js";
import { SessionRegistry } from "./registry.js";
import {
  type BrainProviders,
  type SessionContext,
  type VoiceProviders,
  dispatch,
  makeSessionContext,
  onDevText,
  pushSavedSkills,
} from "./router-ws.js";
import type { Session, SessionSocket } from "./session.js";

/** Окно на присылку client.hello после коннекта (§5). */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** WebSocket.OPEN === 1 по спецификации; держим локально, чтобы не тащить ws в типы (как в session.ts). */
const WS_OPEN = 1;

export interface Gateway {
  app: FastifyInstance;
  registry: SessionRegistry;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Process-level backstop ставим ОДИН раз (даже если createGateway вызовут повторно). */
let gatewayBackstopInstalled = false;

export function createGateway(config: ServerConfig, logger: Logger): Gateway {
  const log: Logger = logger.child("gateway");
  // BACKSTOP устойчивости: неперехваченное исключение/реджект НЕ должно класть весь сервер
  // (форензика логов: uncaughtException рушил процесс → шторм ECONNREFUSED у клиента, потеря всех
  // сессий). Для личного always-on ассистента деградированная сессия лучше мёртвого сервера: логируем
  // громко и продолжаем. (Падение конкретного соединения уже изолировано try/catch в onConnection.)
  if (!gatewayBackstopInstalled) {
    gatewayBackstopInstalled = true;
    process.on("uncaughtException", (e) => log.error("uncaughtException (сервер выжил, backstop)", e instanceof Error ? `${e.message}\n${e.stack}` : String(e)));
    process.on("unhandledRejection", (e) => log.error("unhandledRejection (backstop)", e instanceof Error ? e.message : String(e)));
  }
  const app = Fastify({ logger: false });
  const registry = new SessionRegistry();
  // Наблюдаемость (аудит 2026-07-02): файловый лог поднимается в listen(), закрывается в close().
  let fileLog: FileLogSink | null = null;

  // Голосовые провайдеры — один раз на gateway (§10). Без ключей — mock-режим.
  // TTS оборачиваем кешем (§15): повторяющиеся фразы не синтезируем заново.
  const tts = new CachingTtsProvider(
    createTtsProvider({
      elevenLabsApiKey: config.elevenLabsApiKey,
      voiceId: config.elevenLabsVoiceId,
    }),
  );
  // §10 realtime: прекеш-филлеры «Секунду, сэр.» — маскируют пол латентности Opus. Греем в
  // фоне (не блокируем старт): первые секунды до прогрева филлеров нет, голос работает как
  // прежде. Выключатель JARVIS_VOICE_FILLER=0 → не греем и не играем.
  const filler = new FillerCache();
  if (process.env.JARVIS_VOICE_FILLER === "1") {
    void filler
      .warmup(tts, { voiceId: config.elevenLabsVoiceId })
      .catch((e) => log.warn("прогрев филлеров не удался", { error: e instanceof Error ? e.message : String(e) }));
  }
  const providers: VoiceProviders = {
    stt: createSttProvider({
      deepgramApiKey: config.deepgramApiKey,
      provider: config.sttProvider,
      whisperModel: config.whisperModel,
    }),
    tts,
    voiceId: config.elevenLabsVoiceId,
    filler,
  };

  // Мозговые провайдеры — один раз на gateway (§7, §8, §12, §14).
  // Эмбеддер: OpenAI при наличии ключа, иначе детерминированный hash; поверх — кеш (§15).
  // Эмбеддинги (§1): дефолт — ЛОКАЛЬНАЯ e5-small (реальные векторы, без ключа/облака/GPU; раньше тут
  // был HashEmbeddingProvider = мусорные векторы → память «вспоминала» случайное). OpenAI — опт-ин при
  // наличии ключа (с dimensions=dim, чтобы совпадать с каноном). ВАЖНО: размерность провайдера ОБЯЗАНА
  // совпадать с колонкой episodic_memory.embedding (VECTOR(384) после миграции 0005) — иначе Postgres
  // молча отклоняет INSERT'ы вектора (dim mismatch) → память «немая». Канон dim = config.embeddingDim (384).
  const baseEmbedder = config.openaiApiKey
    ? new OpenAiEmbeddingProvider({
        apiKey: config.openaiApiKey,
        model: config.embeddingModel,
        dim: config.embeddingDim,
      })
    : new LocalEmbeddingProvider();
  const embedder = new CachingEmbeddingProvider(baseEmbedder);
  const web = new CachingWebProvider(new WebProvider(config.braveApiKey));
  const tinkoff = makeTinkoffProvider(); // §трейдинг: РЕАЛЬНЫЙ Тинькофф (read-only) при TINKOFF_INVEST_TOKEN
  const market = new TradingService(new MarketDataProvider(tinkoff), loadPredictionStore(), tinkoff); // данные+анализ+прогнозы+портфель
  const knowledge = new KnowledgeBase(); // §экспертность: база знаний по доменам (свериться перед экспертной задачей)
  // §7: мозг — ТОЛЬКО облачный Opus (Anthropic). Концепция: ничего локального (тонкий
  // клиент, должен идти и на телефоне). Никаких резервных/локальных моделей. Сбой Opus →
  // честный стаб «Связь прервалась, сэр».
  const anthropicLlm = new AnthropicLlmProvider({
    apiKey: config.anthropicApiKey,
    cacheTtl: config.anthropicCacheTtl,
    baseUrl: config.anthropicBaseUrl,
  });
  // Реестр самописных инструментов (§8+): имена встроенных — зарезервированы.
  // Рехидратация с диска — в listen() ДО приёма соединений (чтобы ранние сессии видели
  // выученные инструменты), не fire-and-forget.
  const dynamicTools = new DynamicToolStore(new Set(Object.keys(TOOLS_BY_NAME)));
  // § MCP-host: подключение MCP-серверов из mcp.json. Инструменты — холодные (каталог §15). Создаём
  // тут; connectAll() запускаем в listen БЕЗ await (fire-and-forget) — зависший сервер не должен мешать boot.
  const mcp = new McpManager(new Set(Object.keys(TOOLS_BY_NAME)), loadMcpConfig(), log.child("mcp"));
  // Мост к браузерному расширению «Jarvis Web Hands» (§6): невидимые действия в браузере
  // пользователя на его логинах (фоновые вкладки). Один на gateway.
  const extBridge = new ExtensionBridge(log.child("ext"));
  // §8 МУЛЬТИ-ДЕМО ДИСТИЛЛЯЦИЯ навыка (идея BrowserBC): при 2-м+ показе одной capability сильный тир (Opus)
  // сводит показы в ОДНУ обобщённую устойчивую процедуру (вместо «как сделал последний раз»). Срабатывает РЕДКО
  // (только на повторном обучении), расход мал. Выкл — env JARVIS_SKILL_DISTILL=0.
  const skillDistiller: SkillDistiller | undefined =
    process.env.JARVIS_SKILL_DISTILL === "0"
      ? undefined
      : async ({ name, when, demonstrations }) => {
          const demos = demonstrations.map((d, i) => `### Показ ${i + 1} (когда: ${d.when})\n${d.procedure}`).join("\n\n");
          const system = [
            "Ты дистиллируешь навык-процедуру из НЕСКОЛЬКИХ показов одной и той же задачи (поведенческое клонирование).",
            "Выдай ОДНУ обобщённую устойчивую процедуру (markdown, шаги по пунктам), которая:",
            "- берёт ОБЩИЕ существенные шаги, отбрасывает случайные частности конкретного показа;",
            "- переменные части (имена/тексты/цели) выноси в {{slot}}-плейсхолдеры;",
            "- добавь грабли/нюансы и в КОНЦЕ шаг ВЕРИФИКАЦИИ исхода (не считать сделанным без проверки);",
            "- без преамбул и пояснений — ТОЛЬКО тело процедуры.",
          ].join("\n");
          const user = `Навык: «${name}». Когда применять: ${when}.\n\nПОКАЗЫ:\n${demos}\n\nВыдай одну обобщённую процедуру.`;
          try {
            const resp = await anthropicLlm.complete({
              tier: "fable",
              model: config.models.fable,
              systemStatic: system,
              messages: [{ role: "user", content: user }],
              maxTokens: 1500,
              cachePrefix: false,
            });
            return resp.stubbed ? null : resp.text.trim() || null;
          } catch {
            return null;
          }
        };
  // §проактив-всё: AMBIENT-осведомлённость — Джарвис САМ следит за источниками жизни владельца (счета по
  // датам; непрочитанные Telegram из уже-открытой вкладки, неинвазивно) и проактивно сообщает важное.
  // ДЁШЕВО: источники отдают готовые фразы, движок дедуплицирует + фильтрует по салиентности + проговаривает
  // тем же каналом, что напоминания (0 токенов на тик — token-эконом как качество). Старт в listen.
  const obligationStore = new ObligationStore();
  const ambientEngine = new AmbientEngine([
    createObligationsSource(obligationStore),
    createTelegramSource(extBridge, DEV_USER, { enabled: () => process.env.JARVIS_AMBIENT_TELEGRAM !== "0" }),
  ]);
  const brain: BrainProviders = {
    llm: anthropicLlm,
    episodic: createEpisodicMemory(embedder, Boolean(config.databaseUrl)),
    responseCache: new SemanticResponseCache(embedder), // §15 семантический кэш чисто-вербальных ответов
    embedder, // §20 Волна 1: семантический слой дубль-гейта (STT-обрывок повтора ловится косинусом)
    web,
    market, // §трейдинг (слой 1): рыночные данные + технический анализ (только чтение, без денег)
    knowledge, // §экспертность: база знаний по доменам (knowledge_consult перед экспертной задачей)
    spend: new SpendGuards({ spendCap: config.defaultSpendCap }), // §6B/B5: реестр гвардов по userId
    models: config.models,
    tierThinking: config.tierThinking,
    tasks: loadTaskManager(), // §20: реестр долгих задач, ПЕРЕЖИВАЕТ рестарт (диск-персист §5) — для «сделал?»
    warmth: new SessionWarmth(), // §15: кешируем префикс только в тёплых сессиях
    dynamicTools, // §8+ самописные инструменты
    skills: createSkillProvider(embedder, skillDistiller), // §8 навыки; recall СЕМАНТИЧЕСКИЙ (e5); мульти-демо дистилляция (BrowserBC)
    extBridge, // §6 руки в браузере (невидимая отправка в Telegram)
    reminders: new ReminderService(), // §9 durable-напоминания + проактивная озвучка (старт в listen)
    // §долгие-задачи: durable НАБЛЮДЕНИЕ/мониторинг — recurring-проверка условия (LLM+web на дешёвом тире)
    // + проактивная озвучка при срабатывании (старт в listen). Закрывает гэп «следи за X, скажи когда Y».
    watch: new WatchService(createWatchChecker({ llm: anthropicLlm, web, model: config.models.sonnet, tier: "sonnet" })),
    obligations: obligationStore, // §проактив-всё: счета/обязательства (инструменты + ambient-источник)
    ambient: ambientEngine, // §проактив-всё: движок проактивной осведомлённости (старт в listen)
    resolutionMemory: loadResolutionMemory(), // §: опытная память резолва получателей (скорость), переживает рестарт
    mcp, // § MCP-host: инструменты подключённых MCP-серверов (опционально, по mcp.json)
  };

  // §7/COGS-guard: ВСЕ тиры схлопнуты в одну модель (типовой footgun — TIER1/2/3_MODEL в .env на один
  // id, напр. всё на opus) → эскалация §7 мертва И каждый ход платится по дорогой ставке (см. юнит-
  // экономику). Честно предупреждаем на boot. Универсально: сравниваем id, не привязываясь к модели.
  if (config.models.haiku === config.models.sonnet && config.models.sonnet === config.models.fable) {
    log.warn("§7/COGS: все тиры используют ОДНУ модель — эскалация отключена, каждый ход по дорогой ставке", {
      model: config.models.haiku,
      fix: "развести TIER1_MODEL=claude-sonnet-4-6 / TIER2_MODEL=claude-sonnet-4-6 / TIER3_MODEL=claude-opus-4-8 (Haiku не используем)",
    });
  }

  // Продакшен-sweep реестра задач (§20): без периодической чистки терминальные задачи копятся в
  // памяти gateway бесконечно. Retention увеличен с 10 мин до 6 ч (env JARVIS_TASK_RETENTION_MS),
  // чтобы «сделал?» работал и спустя час/деплой-рестарт (sweep клиенту ничего не шлёт — чипами
  // управляет renderer сам, так что долгий retention копит лишь сервер-память, UI не засоряет).
  // parseInt(env ?? "") → NaN на пустом/незаданном/пробельном (а Number("")===0 ловушка: схлопнул бы
  // retention до 60с и вычистил задачи через минуту). Зеркалит парсинг JARVIS_TASK_MAX_MS.
  const parsedRetention = Number.parseInt(process.env.JARVIS_TASK_RETENTION_MS ?? "", 10);
  const taskRetentionMs = Number.isFinite(parsedRetention)
    ? Math.min(7 * 24 * 60 * 60_000, Math.max(60_000, parsedRetention))
    : 6 * 60 * 60_000;
  const taskSweep = setInterval(() => brain.tasks.sweep(Date.now(), taskRetentionMs), 5 * 60_000);
  taskSweep.unref?.();

  // §трейдинг: АВТО-ПРЕДИКТОР — фоновый цикл прогнозов ТОЛЬКО по историческому перевесу, чтобы набрать
  // выборку за ЧАСЫ (env JARVIS_AUTO_PREDICT=1). Правило-базный пред-скрин → не жжёт Anthropic-кредиты.
  // СЛОЙ 2 (env JARVIS_AUTO_PREDICT_EXPERT=1, по умолчанию ВЫКЛ): отобранные скрином сетапы эскалируются
  // LLM-ЭКСПЕРТУ (Opus/fable-тир) — сверка с базой знаний → стоп+тейк по R:R. Бьёт РЕДКО (только по
  // кандидатам) → расход ограничен; включать осознанно (автономные LLM-вызовы).
  const autoPredCfg = autoPredictorConfigFromEnv(DEV_USER);
  const expertBudgetUsd = (() => {
    const n = Number.parseFloat(process.env.JARVIS_AUTO_PREDICT_EXPERT_BUDGET_USD ?? "");
    return Number.isFinite(n) && n > 0 ? n : undefined; // жёсткий потолок трат эксперта (USD); нет → без лимита
  })();
  const tradeExpert =
    process.env.JARVIS_AUTO_PREDICT_EXPERT === "1"
      ? new TradeExpert(anthropicLlm, knowledge, { model: config.models.fable, tier: "fable", budgetUsd: expertBudgetUsd })
      : undefined;
  const autoPredictor = autoPredCfg ? new AutoPredictor(market, autoPredCfg, tradeExpert) : null;
  autoPredictor?.start();
  if (tradeExpert) log.info("§трейдинг: LLM-эксперт в петле прогноза ВКЛ", { model: config.models.fable, budgetUsd: expertBudgetUsd ?? "без лимита" });

  // Регистрация плагина WebSocket до объявления маршрутов.
  void app.register(fastifyWebsocket);

  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (connection) => {
      // @fastify/websocket v11: первый аргумент — это сам WebSocket (ws.WebSocket).
      const socket = connection as unknown as RawWs;
      onConnection(socket, config, registry, providers, brain, log);
    });
    // Канал расширения (Chrome). Своя WS, отдельно от клиентского /ws (другой протокол).
    instance.get("/ext", { websocket: true }, (connection, request) => {
      const ws = connection as unknown as RawWs;
      // §sec (H13): /ext = «руки браузера» (telegram.send, чтение залогиненных вкладок). Раньше
      // принимали ЛЮБОЕ соединение → вредоносная веб-страница открывала ws://…/ext и перехватывала
      // канал. Теперь пускаем ТОЛЬКО расширение (Origin chrome-extension://) ИЛИ локальный клиент без
      // Origin (тесты/нативный). Веб-страница (http/https Origin) → отклоняем.
      const origin = String((request as { headers?: Record<string, unknown> })?.headers?.origin ?? "").toLowerCase();
      if (origin && !origin.startsWith("chrome-extension://")) {
        log.warn("§sec: /ext соединение отклонено по Origin (не расширение)", { origin });
        try {
          ws.close();
        } catch {
          /* уже закрыт */
        }
        return;
      }
      const sock: ExtSocket = { send: (d) => ws.send(d), close: () => ws.close() };
      extBridge.attach(sock);
      ws.on("message", (raw: unknown) => extBridge.handleMessage(rawToText(raw)));
      ws.on("close", () => extBridge.detach(sock));
      ws.on("error", () => extBridge.detach(sock));
    });
  });

  // §sec (H9/M12): DEV/EXT HTTP-роуты исполняют РЕАЛЬНЫЕ действия (ActionCommand в актуаторы минуя §14,
  // отправка Telegram, инъекция в агента, VAD). Раньше — без всякой аутентификации → любой локальный
  // процесс (а при ALLOW_REMOTE — весь LAN) исполнял команды на ПК, обходя WS-auth. Теперь: весь блок
  // ТОЛЬКО при JARVIS_DEV_HTTP=1 (деф ВЫКЛ → 404 в обычном прогоне), + loopback-only, + опц. токен
  // JARVIS_DEV_TOKEN (заголовок x-jarvis-dev-token). Расширение работает через /ext WS (выше), не эти роуты.
  const devHttpOn = process.env.JARVIS_DEV_HTTP === "1";
  const devToken = (process.env.JARVIS_DEV_TOKEN ?? "").trim();
  const devPre = async (req: { ip?: string; headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<unknown> => {
    const ip = String(req.ip ?? "").replace(/^::ffff:/, "");
    if (!isLoopbackHost(ip)) return reply.code(403).send({ ok: false, error: "dev-роуты доступны только с loopback" });
    if (devToken && String(req.headers["x-jarvis-dev-token"] ?? "") !== devToken)
      return reply.code(403).send({ ok: false, error: "неверный dev-токен" });
    return undefined;
  };
  if (devHttpOn) {
    log.warn("§sec: DEV/EXT HTTP-роуты ВКЛЮЧЕНЫ (JARVIS_DEV_HTTP=1) — loopback-only" + (devToken ? " + токен" : " БЕЗ токена (задай JARVIS_DEV_TOKEN)"));

  // DEV-триггер для проверки руки в браузере: POST /ext/telegram {to,text}.
  app.post("/ext/telegram", { preHandler: devPre }, async (req) => {
    const body = (req.body ?? {}) as { to?: string; text?: string };
    if (!extBridge.connected) return { ok: false, error: "расширение не подключено" };
    try {
      const data = await extBridge.telegramSend(String(body.to ?? ""), String(body.text ?? ""));
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // DEV-триггер для проверки ОТПРАВКИ ФАЙЛА (аудио): POST /ext/telegram_file {to, audioB64}.
  app.post("/ext/telegram_file", { preHandler: devPre }, async (req) => {
    const body = (req.body ?? {}) as { to?: string; audioB64?: string };
    if (!extBridge.connected) return { ok: false, error: "расширение не подключено" };
    try {
      const data = await extBridge.telegramSendVoice(String(body.to ?? ""), String(body.audioB64 ?? ""));
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // DEV-триггер: список открытых вкладок (browser_tabs end-to-end без модели). GET /ext/tabs.
  app.get("/ext/tabs", { preHandler: devPre }, async () => {
    if (!extBridge.connected) return { ok: false, error: "расширение не подключено" };
    try {
      const data = await extBridge.tabList();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // DEV-диагностика резолва получателя: структура результатов поиска (диалоги vs глобальный/каналы).
  app.post("/ext/tgdiag", { preHandler: devPre }, async (req) => {
    const body = (req.body ?? {}) as { query?: string };
    if (!extBridge.connected) return { ok: false, error: "расширение не подключено" };
    try {
      const data = await extBridge.request({ type: "telegram.diag", query: String(body.query ?? "") }, 30_000);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // DEV-триггер: перечитать распакованное расширение с диска (chrome.runtime.reload),
  // чтобы подхватить правки background.js без ручного ↻ в chrome://extensions.
  app.post("/ext/reload", { preHandler: devPre }, async () => {
    if (!extBridge.connected) return { ok: false, error: "расширение не подключено" };
    try {
      const data = await extBridge.request({ type: "reload" }, 5_000);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // DEV-триггер: послать РЕАЛЬНЫЙ ActionCommand в подключённый клиент и вернуть НАСТОЯЩИЙ результат
  // (для прямого теста клиентских актуаторов fs/clipboard/app/screen — текст-драйвер их фейкает).
  // POST /dev/action {kind, ...поля команды}. Берёт последнюю (свежую) клиентскую сессию.
  app.post("/dev/action", { preHandler: devPre }, async (req) => {
    const cmd = (req.body ?? {}) as { kind?: string } & Record<string, unknown>;
    if (!cmd.kind) return { ok: false, error: "нужен kind" };
    const sessions = registry.all();
    if (!sessions.length) return { ok: false, error: "нет подключённых сессий (Electron-клиент не запущен?)" };
    const session = sessions[sessions.length - 1];
    if (!session) return { ok: false, error: "нет сессии" };
    try {
      const result = await session.sendAction(cmd as unknown as Parameters<typeof session.sendAction>[0], 30_000);
      return { ok: result.ok, data: result.data, error: result.error?.message ?? result.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // DEV: ПОЛНЫЙ цикл как при голосе — инъекция текста в сессию ЖИВОГО клиента: команда идёт через
  // агента, а action.command'ы исполняются НАСТОЯЩИМИ актуаторами клиента (не фейк текст-драйвера).
  // Берёт последнюю клиентскую сессию. Ответы агента → в лог (server.out.log «Джарвис →») + клиенту.
  app.post("/dev/say", { preHandler: devPre }, async (req) => {
    const body = (req.body ?? {}) as { text?: string };
    const text = String(body.text ?? "").trim();
    if (!text) return { ok: false, error: "нужен text" };
    const ids = registry.all().map((s) => s.sessionId);
    let ctx: SessionContext | undefined;
    for (let i = ids.length - 1; i >= 0; i -= 1) { const c = liveCtxs.get(ids[i]!); if (c) { ctx = c; break; } }
    if (!ctx) return { ok: false, error: "нет живой клиентской сессии (Electron-клиент не запущен?)" };
    void onDevText(ctx, { text }).catch((e) => log.error("/dev/say onDevText", e instanceof Error ? e.message : String(e)));
    return { ok: true, sessionId: ctx.session.sessionId, note: "ответ агента в server.out.log и у клиента" };
  });

  // DEV: инъекция VAD-события в живую сессию (тест barge-in программно, без живого голоса).
  // POST /dev/vad {state:"barge_in"|"speech_start"|"speech_end"} — зовёт ctx.voice.onVadEvent.
  app.post("/dev/vad", { preHandler: devPre }, async (req) => {
    const state = String((req.body as { state?: string })?.state ?? "").trim();
    if (!["barge_in", "speech_start", "speech_end"].includes(state)) return { ok: false, error: "state: barge_in|speech_start|speech_end" };
    const ids = registry.all().map((s) => s.sessionId);
    let ctx: SessionContext | undefined;
    for (let i = ids.length - 1; i >= 0; i -= 1) { const c = liveCtxs.get(ids[i]!); if (c) { ctx = c; break; } }
    if (!ctx) return { ok: false, error: "нет живой клиентской сессии" };
    ctx.voice.onVadEvent(state as "barge_in" | "speech_start" | "speech_end");
    return { ok: true, sessionId: ctx.session.sessionId, injected: state };
  });
  } // end if (devHttpOn) — §sec gate for DEV/EXT HTTP routes

  // health-чек + метрики кеша (§15): hit/miss по эмбеддингам/web/TTS — для замера
  // эффективности кеширования платных вызовов.
  app.get("/healthz", async () => ({
    ok: true,
    sessions: registry.size,
    cache: {
      embeddings: embedder.stats,
      web: web.stats,
      tts: tts.stats,
    },
  }));

  // ПРОД-ТЕЛЕМЕТРИЯ агента (obs/metrics): токены по типам, стоимость в USD, латентность p50/p95/avg,
  // error-rate, cache hit-rate, токенов/запрос — агрегаты по окну последних задач. Для дашборда/алертов.
  app.get("/stats", async () => metrics.snapshot());

  // COGS-ДАШБОРД (юнит-экономика): окно телеметрии — стоимость по ФАКТИЧЕСКИМ моделям (costByModel),
  // cache hit-rate, cold-write токены, латентность — ПЛЮС накопленный расход per-user из SpendGuard.
  // Заменяет «оценки» юнит-экономики реальными числами для калибровки тарифов/потолков (§14).
  app.get("/cogs", async () => ({
    window: metrics.snapshot(),
    users: brain.spend.allSnapshots(),
  }));

  return {
    app,
    registry,
    async listen() {
      // Наблюдаемость (аудит 2026-07-02): durable файловый лог + JSONL-метрики в dataDir/logs/ —
      // раньше сервер писал ТОЛЬКО в консоль, история после закрытия/деплоя терялась (аудит был слеп).
      // Поднимаем ПЕРВЫМ, чтобы в файл попал и сам boot. Выключатель JARVIS_FILE_LOG=0.
      fileLog = initFileLog();
      metrics.enableJsonl();
      // §6B/B3: профиль теперь партиционирован по userId и грузится per-session в handshake
      // (loadProfile(userId)), а не один глобальный на boot.
      await loadConsent(); // §14: помним согласия на отправку (Кате можно) между сессиями
      await dynamicTools.load(); // §8+: выученные инструменты доступны с первой сессии
      // §6B/B5: траты периода теперь гидрируются per-user в handshake (brain.spend.hydrate(userId)),
      // а не одним глобальным гвардом на boot (тот не имел userId → persist usage_quota был мёртв).
      await brain.reminders.start(); // §9: поднять напоминания с диска, завести таймер, догнать просроченные
      await brain.watch?.start(); // §долгие-задачи: поднять наблюдения с диска, завести recurring-таймер проверок
      await obligationStore.load(); // §проактив-всё: поднять обязательства/счета с диска
      await brain.ambient?.start(); // §проактив-всё: запустить ambient-движок (счета по датам + Telegram-непрочитанные)
      // §3 верификация диктора: движок отпечатка (keyless ONNX, sherpa-onnx-node) поднимаем по
      // умолчанию (флаг JARVIS_SPEAKER_GATE — теперь KILL-SWITCH: `=0` ВЫКЛ; иначе ВКЛ). Раньше
      // требовался ЯВНЫЙ `=1`, и тогда движок не создавался → кнопка «Записать голос» в настройках
      // молча падала (enroll нужен ctx.speakerVerifier), а UI врал «мало речи?». Причина прежнего
      // строгого opt-in — конфликт sherpa-onnx-node ↔ onnxruntime-node (эмбеддер e5) в ОДНОМ процессе
      // на Windows — УЖЕ РЕШЁН speaker-САЙДКАРОМ (sherpa в дочернем процессе, изолирован; e5 в главном
      // жив). Так что строгий `=1` устарел и противоречил `router-ws makeSessionContext` (там гейт
      // активен при `!== "0"`, «enrollment сам включает фильтрацию»). Согласуем: движок ВКЛ при `!=="0"`.
      // ⚠️ Создание движка ≠ фильтрация: пока НЕТ ни одного записанного голоса, `speakerGateActive()`
      // (profiles>0) ложен → реагируем на всех, как раньше; фильтрация включается ПОСЛЕ первой записи.
      // `JARVIS_SPEAKER_SIDECAR=0` → in-process (Linux/без конфликта). Любой сбой сайдкара → Mock
      // (ready=false → enroll честно падает, гейт не запирает владельца), boot цел.
      if (process.env.JARVIS_SPEAKER_GATE !== "0") {
        try {
          const store = new VoiceProfileStore();
          await store.load();
          providers.speakerStore = store;
          providers.speakerVerifier =
            process.env.JARVIS_SPEAKER_SIDECAR === "0" ? await createSpeakerVerifier() : await createSpeakerVerifierSidecar();
          log.info("верификация диктора (движок поднят; фильтрация — после первой записи голоса)", {
            ready: providers.speakerVerifier.ready,
            voices: store.total,
            mode: process.env.JARVIS_SPEAKER_SIDECAR === "0" ? "in-process" : "sidecar",
          });
        } catch (e) {
          log.warn("верификация диктора не поднялась", { error: e instanceof Error ? e.message : String(e) });
        }
      } else {
        log.info("верификация диктора ВЫКЛ (kill-switch JARVIS_SPEAKER_GATE=0)");
      }
      void mcp.connectAll(); // § MCP: подключаем серверы В ФОНЕ — зависший/долгий npx не должен держать boot
      // P1.3 ПРОГРЕВ ЭМБЕДДЕРА: e5-модель грузится ЛЕНИВО при первом embed(); на голосовом пути retrieval
      // идёт под жёстким IO-таймаутом (~350мс) → холодная первая загрузка не успевает → факты [] («будто
      // без памяти в начале разговора»). Один фоновый embed прогревает пайплайн заранее (не блокирует boot).
      void embedder
        .embed("warmup", "query")
        .then((v) => log.info("эмбеддер прогрет на старте", { ready: Array.isArray(v) && v.length > 0 }))
        .catch((e) => log.warn("прогрев эмбеддера пропущен", e instanceof Error ? e.message : String(e)));
      // §память: досчитать эмбеддинги осиротевших фактов (embedding=NULL — писались, пока эмбеддер был
      // мёртв на Windows-CPU) → вернуть их в семантический поиск. В фоне, идемпотентно, не блокирует boot.
      void brain.episodic
        .backfillMissingEmbeddings?.(2000)
        ?.then((r) => {
          if (r.fixed > 0) log.info("эпизодическая память: восстановлено эмбеддингов на старте", r);
        })
        .catch((e) => log.warn("бэкилл эмбеддингов пропущен", e instanceof Error ? e.message : String(e)));
      // §мультитенант: общая библиотека навыков — провижн псевдо-юзера (FK) + идемпотентный сид
      // курируемых процедур (видны всем через recall). Best-effort, не блокирует boot и не валит его.
      void ensureUser(SHARED_USER_ID)
        .then(() => seedSharedSkills(SHARED_SKILL_SEED))
        .catch((e) => log.warn("общая библиотека навыков: сид пропущен", e instanceof Error ? e.message : String(e)));
      const bindHost = resolveBindHost(config, log);
      await app.listen({ port: config.port, host: bindHost });
      log.info("gateway слушает", { host: bindHost, port: config.port });
    },
    async close() {
      clearInterval(taskSweep);
      autoPredictor?.stop(); // §трейдинг: остановить авто-предиктор
      brain.reminders.stop(); // §9: остановить таймер напоминаний (симметрично watch/ambient) перед flush
      brain.watch?.stop(); // §долгие-задачи: остановить таймер наблюдений
      brain.ambient?.stop(); // §проактив-всё: остановить ambient-движок
      flushTaskStores(); // §5/§20: дописать отложенный снимок реестра, чтобы «сделал?» пережил graceful-рестарт
      flushResolutionStores(); // §: дописать опытную память резолвов перед выходом
      flushWorkingStores(); // H9: дописать рабочую память диалога (иначе ход за <120мс до рестарта теряется)
      // M13: дописать durable-сторы проактива (reminders/watch/ambient-seen/obligations) — иначе рестарт
      // терял in-flight запись (отменённое напоминание всё равно срабатывало; уже-показанное ambient
      // пере-срабатывало). Bounded 2с — зависший диск не должен держать выход (как drainAll ниже).
      await Promise.race([
        Promise.all([
          brain.reminders.flush().catch(() => {}),
          brain.watch?.flush().catch(() => {}),
          brain.ambient?.flush().catch(() => {}),
          obligationStore.flush().catch(() => {}),
        ]),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      // §14: дописать последний best-effort персист потраченного (раньше drain() не дожидались →
      // usage_quota терялся при graceful-рестарте). Bounded 2с — зависшая БД не должна держать выход.
      await Promise.race([brain.spend.drainAll().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      // L3: убить speaker-сайдкар (sherpa-child) — иначе зомби с моделью в памяти при taskkill /F на порту.
      providers.speakerVerifier?.dispose?.();
      // L6: дождаться закрытия MCP-клиентов (stdio-child), bounded — зависший клиент не держит выход.
      // ⚠️ kill дерева stdio-детей на Windows (taskkill /T) — внутри McpManager.dispose (вне этого кластера).
      await Promise.race([mcp.dispose().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      registry.teardownAll();
      await app.close();
      log.info("gateway остановлен");
      metrics.disableJsonl();
      fileLog?.dispose(); // дослать хвост лог-буфера на диск перед выходом (наблюдаемость)
    },
  };
}

/** Минимальный контракт «сырого» ws-сокета, который нам нужен. */
interface RawWs {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  readyState: number;
}

/** §dev: ctx ЖИВЫХ клиентских соединений (для /dev/say — инъекция команды в сессию реального клиента,
 *  чтобы действия исполнялись по-настоящему его актуаторами, как при голосе). */
const liveCtxs = new Map<string, SessionContext>();

/** Обработать новое соединение: handshake → сессия → heartbeat → router. */
function onConnection(
  ws: RawWs,
  config: ServerConfig,
  registry: SessionRegistry,
  providers: VoiceProviders,
  brain: BrainProviders,
  log: Logger,
): void {
  let ctx: SessionContext | null = null;
  let handshakeDone = false;
  // Single-flight (§6B): handshake стал async (валидация/провижн БД). Латч не даёт второму hello /
  // гонке reconnect запустить ВТОРОЙ doHandshake (двойной провижн / двойная сессия). Ставится
  // СИНХРОННО до любого await — между hello и резолвом промиса handshakeDone ещё false, поэтому любой
  // промежуточный кадр падает в ту же ignore-ветку, что и сегодня (буфер не нужен, семантика та же).
  let handshakeStarted = false;
  // H7: сокет мог закрыться ПОКА doHandshake ждал БД (resolveAndProvision/hydrate). ws.on('close')
  // тогда срабатывает с ctx===null и выходит БЕЗ scheduleRemove; затем промис резолвится и без этого
  // флага вставил бы Session + heartbeat + приветствие в МЁРТВЫЙ сокет, который уже не закроется →
  // перманентная утечка сессии. Флаг ставится в close, сверяется после await (см. .then ниже).
  let socketClosed = false;

  // Адаптер RawWs → SessionSocket (минимальный контракт Session).
  const sock: SessionSocket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
  };

  // Таймаут handshake: нет client.hello вовремя → закрыть (§5).
  const handshakeTimer = setTimeout(() => {
    if (!handshakeDone) {
      log.warn("handshake timeout — закрываем соединение");
      sendError(ws, { code: "unauthorized", message: "no client.hello" });
      ws.close(4001, "handshake_timeout");
    }
  }, HANDSHAKE_TIMEOUT_MS);
  if (typeof handshakeTimer.unref === "function") handshakeTimer.unref();

  ws.on("message", (raw: unknown) => {
    const env = parseEnvelope(raw, log);
    if (!env) {
      sendError(ws, { code: "internal", message: "bad envelope" });
      return;
    }

    // До handshake принимаем только client.hello (и только ОДИН — single-flight латч).
    if (!handshakeDone) {
      if (env.type !== "client.hello" || handshakeStarted) {
        log.warn("кадр до handshake — игнор", { type: env.type });
        return;
      }
      handshakeStarted = true; // СИНХРОННО, до await
      clearTimeout(handshakeTimer); // СИНХРОННО, до await — медленный async-handshake не уронит 5с-таймаут в двойной close
      // Инициализация сессии в .catch: ошибка здесь (напр. сбой регистрации канала) НЕ должна
      // всплывать в uncaughtException и КЛАСТЬ ВЕСЬ СЕРВЕР (форензика логов: uncaughtException
      // 'registerSpeaker' рушил процесс → шторм ECONNREFUSED на клиенте). Падает только ЭТО соединение.
      void doHandshake(env as Envelope<Hello>, sock, ws, config, registry, providers, brain, log)
        .then((c) => {
          // H7: сокет закрылся, пока doHandshake ждал БД → немедленный teardown вместо утечки. НЕ
          // регистрируем в liveCtxs и НЕ полагаемся на ws.on('close') (он уже отработал с ctx===null).
          if (c && (socketClosed || ws.readyState !== WS_OPEN)) {
            log.warn("handshake завершился после закрытия сокета — сношу сессию (H7)", { sessionId: c.session.sessionId });
            c.heartbeat.stop();
            c.voice.dispose();
            // isBoundTo-гард (как в ws.on('close')): сносим сессию, ТОЛЬКО если её всё ещё держит ЭТОТ
            // сокет. Если гонка reconnect уже забрала сессию новым соединением (resume) — не трогаем её,
            // лишь глушим heartbeat/voice ЭТОГО мёртвого канала (иначе снесли бы живую чужую сессию).
            if (c.session.isBoundTo(sock)) registry.remove(c.session.sessionId); // teardown → onTeardown (отмена задач) + снятие с учёта
            return;
          }
          ctx = c;
          handshakeDone = c !== null; // null (version_mismatch/unauthorized/internal) → сокет уже закрыт в doHandshake
          if (c) liveCtxs.set(c.session.sessionId, c); // §dev /dev/say
        })
        .catch((e: unknown) => {
          log.error("ошибка handshake/инициализации сессии — закрываю соединение", e instanceof Error ? e.message : String(e));
          sendError(ws, { code: "internal", message: "ошибка инициализации сессии" });
          ws.close(1011, "session_init_failed");
        });
      return;
    }

    if (!ctx) return;
    // Упорядоченная обработка; ошибки внутри dispatch не валят соединение.
    void dispatch(ctx, env).catch((e: unknown) => {
      log.error("ошибка dispatch", e instanceof Error ? e.message : String(e));
    });
  });

  ws.on("close", () => {
    clearTimeout(handshakeTimer);
    socketClosed = true; // H7: если doHandshake ещё в полёте — его .then увидит флаг и снесёт сессию сам
    if (!ctx) return;
    // Heartbeat ЭТОГО соединения глушим всегда (иначе при resume на одну Session работали бы ДВА
    // heartbeat-а — старый добивал бы живой сокет ложным onDead).
    ctx.heartbeat.stop();
    ctx.voice.dispose(); // голосовой контур — per-connection, освобождаем в любом случае
    // RESUME-ГОНКА: если сессию уже забрало более новое соединение (rebind), это закрытие СТАРОГО
    // сокета — НЕ трогаем сессию/фоновые задачи/реестр (ими владеет новое соединение).
    if (!ctx.session.isBoundTo(sock)) {
      log.info("закрыт старый сокет после resume — сессия жива на новом", { sessionId: ctx.session.sessionId });
      return;
    }
    ctx.disposeAgent(); // §20: снять незавершённые фоновые задачи этого соединения (агент-деп — per-conn)
    liveCtxs.delete(ctx.session.sessionId); // §dev /dev/say
    forgetClientContext(ctx.session.sessionId);
    brain.warmth.forget(ctx.session.sessionId); // §15: не копим тёплость мёртвых сессий
    // §5 RESUME: НЕ убиваем сессию сразу — держим грейс-окно. Reconnect (блип сети/перезапуск клиента в
    // пределах окна) восстановит ИСТОРИЮ ДИАЛОГА (память скоуплена на Session). Не вернулся → авто-remove.
    registry.scheduleRemove(ctx.session.sessionId);
    log.info("соединение закрыто (сессия в resume-окне)", { sessionId: ctx.session.sessionId });
  });

  ws.on("error", (err: Error) => {
    log.warn("ws error", err.message);
  });
}

/** Выполнить handshake и поднять сессию (§5). Возвращает контекст или null. */
async function doHandshake(
  env: Envelope<Hello>,
  sock: SessionSocket,
  ws: RawWs,
  config: ServerConfig,
  registry: SessionRegistry,
  providers: VoiceProviders,
  brain: BrainProviders,
  log: Logger,
): Promise<SessionContext | null> {
  const hello = env.payload;

  // §5: несовпадение мажора протокола → ошибка + закрыть.
  if (!isProtocolCompatible(hello.protocolVersion)) {
    log.warn("version_mismatch", {
      client: hello.protocolVersion,
      server: config.protocolVersion,
    });
    sendError(ws, {
      code: "version_mismatch",
      message: `протокол клиента v${hello.protocolVersion} несовместим с сервером v${config.protocolVersion}`,
    });
    ws.close(4002, "version_mismatch");
    return null;
  }

  // §13/Фаза 6B: userId из токена (identity.ts) + lazy-provision строки users ДО createOrResume —
  // иначе per-user INSERT в сессии молча падает на FK (Hazard 1). На дефолтном loopback это ПАРТИЦИЯ
  // (токен = ключ раздела), не auth; реальная сверка по auth_tokens дремлет за JARVIS_AUTH_STRICT.
  const userId = await resolveAndProvision(hello.token);
  if (userId === null) {
    // Срабатывает ТОЛЬКО в strict-режиме (LAN/hosted) при отклонённом токене — на дефолте недостижимо.
    log.warn("unauthorized — токен отклонён (strict)");
    sendError(ws, { code: "unauthorized", message: "token rejected" });
    ws.close(4003, "unauthorized");
    return null;
  }

  // §6B/B3: грузим РАЗДЕЛ профиля этого userId в кеш ДО makeSessionContext/онбординга — иначе
  // getProfile(userId) вернёт пусто (профиль партиционирован по userId, не глобальный синглтон).
  // Профиль и траты независимы (разные таблицы, друг друга не читают) и оба идут ПОСЛЕ
  // resolveAndProvision (FK-родитель провижен) → грузим параллельно, экономя один RTT на connect.
  // §6B/B5: hydrate — траты периода из usage_quota ДО первого check (рестарт не обнуляет месячный
  // потолок). Оба идемпотентны; без БД/userId — no-op (best-effort).
  await Promise.all([loadProfile(userId), brain.spend.hydrate(userId)]);

  const { session, resumed } = registry.createOrResume(userId, sock, hello.resumeSessionId);

  // Heartbeat: при гибели соединения закрываем сокет (§5).
  const heartbeat = startHeartbeat(session, () => {
    ws.close(4000, "heartbeat_timeout");
  });

  // server.hello — подтверждение установления сессии (§5).
  session.send("server.hello", {
    sessionId: session.sessionId,
    protocolVersion: config.protocolVersion,
    resumed,
  });

  log.info("handshake завершён", { sessionId: session.sessionId, resumed });
  const ctx = makeSessionContext(session, heartbeat, providers, brain);

  // §8: пробрасываем ранее записанные навыки в UI (список «Навыки» + возможность повтора).
  pushSavedSkills(ctx);

  // Онбординг (§11): на свежую (не возобновлённую) сессию Джарвис здоровается голосом —
  // КОНТЕКСТНО (время суток + что помнит о пользователе), при уместности с проактивным
  // вопросом. На resume — молчит (уже знакомы).
  if (!resumed) startOnboarding(ctx, session, brain, log);

  return ctx;
}

function startOnboarding(ctx: SessionContext, session: Session, brain: BrainProviders, log: Logger): void {
  // Небольшая задержка — чтобы renderer успел подписаться на speak.chunk/transcript.
  const t = setTimeout(() => {
    // Приветствие ТОЛЬКО озвучивается (ambient). НЕ шлём ui.display/transcript — иначе на
    // каждое переподключение копится карточка-спам (НЕ чат-бот, §концепт). Контекст — best-effort.
    const p = getProfile(session.userId);
    void buildGreeting(
      { llm: brain.llm, episodic: brain.episodic, models: brain.models },
      session.userId,
      { name: p.displayName, facts: p.facts },
    )
      .then((line) => {
        ctx.voice.speak(line);
        log.info("онбординг: приветствие произнесено");
      })
      .catch((e) => log.warn("онбординг не удался", e instanceof Error ? e.message : String(e)));
  }, 800);
  if (typeof t.unref === "function") t.unref();
}

/** Нормализовать сырой WS-кадр (string | Buffer | {data}) в текст. */
function rawToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  const data = (raw as { data?: unknown })?.data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(raw);
}

/** Разобрать входящий кадр в Envelope (с грубой валидацией §5). */
function parseEnvelope(raw: unknown, log: Logger): Envelope | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : raw instanceof Buffer
          ? raw.toString("utf8")
          : Buffer.isBuffer((raw as { data?: unknown })?.data)
            ? ((raw as { data: Buffer }).data).toString("utf8")
            : String(raw);
    const parsed: unknown = JSON.parse(text);
    if (!isEnvelope(parsed)) {
      log.warn("кадр не является Envelope");
      return null;
    }
    return parsed;
  } catch (e) {
    log.warn("не удалось распарсить кадр", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Отправить ProtocolError напрямую в сырой сокет (до/без сессии). */
function sendError(ws: RawWs, payload: ProtocolError): void {
  try {
    ws.send(JSON.stringify({ id: "", ts: Date.now(), type: "error", payload }));
  } catch {
    /* сокет уже мёртв — игнор */
  }
}
