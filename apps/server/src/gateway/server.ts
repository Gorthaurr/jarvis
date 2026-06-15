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
import { SpendGuard } from "../billing/index.js";
import { SessionWarmth } from "../brain/agent/warmth.js";
import { TaskManager } from "../brain/tasks/manager.js";
import { DynamicToolStore } from "../brain/tools/dynamic.js";
import { ButlerAcks } from "../brain/persona/acks.js";
import { buildSystemPrompt } from "../brain/persona/index.js";
import { TOOLS_BY_NAME } from "@jarvis/tools";
import { AnthropicLlmProvider } from "../integrations/anthropic.js";
import { getProfile, loadProfile } from "../brain/profile.js";
import {
  CachingEmbeddingProvider,
  HashEmbeddingProvider,
  OpenAiEmbeddingProvider,
} from "../integrations/openai-embeddings.js";
import { createSttProvider, createTtsProvider } from "../integrations/providers.js";
import { CachingTtsProvider } from "../integrations/tts-cache.js";
import { CachingWebProvider, WebProvider } from "../integrations/web.js";
import { createEpisodicMemory } from "../memory/episodic.js";
import { createSkillProvider } from "../memory/skills.js";
import { forgetClientContext } from "../proactive/salience.js";
import { ExtensionBridge, type ExtSocket } from "./extension-bridge.js";
import { startHeartbeat } from "./heartbeat.js";
import { SessionRegistry } from "./registry.js";
import {
  type BrainProviders,
  type SessionContext,
  type VoiceProviders,
  dispatch,
  makeSessionContext,
  pushSavedSkills,
} from "./router-ws.js";
import type { Session, SessionSocket } from "./session.js";

/** Окно на присылку client.hello после коннекта (§5). */
const HANDSHAKE_TIMEOUT_MS = 5_000;

export interface Gateway {
  app: FastifyInstance;
  registry: SessionRegistry;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createGateway(config: ServerConfig, logger: Logger): Gateway {
  const log: Logger = logger.child("gateway");
  const app = Fastify({ logger: false });
  const registry = new SessionRegistry();

  // Голосовые провайдеры — один раз на gateway (§10). Без ключей — mock-режим.
  // TTS оборачиваем кешем (§15): повторяющиеся фразы не синтезируем заново.
  const tts = new CachingTtsProvider(
    createTtsProvider({
      elevenLabsApiKey: config.elevenLabsApiKey,
      voiceId: config.elevenLabsVoiceId,
    }),
  );
  const providers: VoiceProviders = {
    stt: createSttProvider({
      deepgramApiKey: config.deepgramApiKey,
      provider: config.sttProvider,
      whisperModel: config.whisperModel,
    }),
    tts,
    voiceId: config.elevenLabsVoiceId,
  };

  // Мозговые провайдеры — один раз на gateway (§7, §8, §12, §14).
  // Эмбеддер: OpenAI при наличии ключа, иначе детерминированный hash; поверх — кеш (§15).
  // ВАЖНО: размерность hash-фоллбэка должна совпадать с колонкой episodic_memory.embedding
  // (VECTOR(1536), §13). Иначе при DATABASE_URL без OPENAI_API_KEY все INSERT'ы вектора
  // молча отклоняются Postgres (dim mismatch) → эпизодическая память «немая».
  const baseEmbedder = config.openaiApiKey
    ? new OpenAiEmbeddingProvider({
        apiKey: config.openaiApiKey,
        model: config.embeddingModel,
        dim: config.embeddingDim,
      })
    : new HashEmbeddingProvider(config.embeddingDim);
  const embedder = new CachingEmbeddingProvider(baseEmbedder);
  const web = new CachingWebProvider(new WebProvider(config.braveApiKey));
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
  // §11/§20: дворецкие подтверждения голосом персоны. Пул генерится один раз (warm в
  // listen), ack отдаётся мгновенно из готового пула — задержки на модель в момент задачи нет.
  const acks = new ButlerAcks({
    llm: anthropicLlm,
    model: config.models.haiku,
    persona: buildSystemPrompt().staticPrefix,
  });
  // Мост к браузерному расширению «Jarvis Web Hands» (§6): невидимые действия в браузере
  // пользователя на его логинах (фоновые вкладки). Один на gateway.
  const extBridge = new ExtensionBridge(log.child("ext"));
  const brain: BrainProviders = {
    llm: anthropicLlm,
    episodic: createEpisodicMemory(embedder, Boolean(config.databaseUrl)),
    web,
    spend: new SpendGuard({ spendCap: config.defaultSpendCap }),
    models: config.models,
    tasks: new TaskManager(), // общий реестр долгих задач на gateway (§20)
    warmth: new SessionWarmth(), // §15: кешируем префикс только в тёплых сессиях
    dynamicTools, // §8+ самописные инструменты
    skills: createSkillProvider(), // §8 выученные показом навыки
    acks, // §11 дворецкие подтверждения (прегенерация голосом персоны)
    extBridge, // §6 руки в браузере (невидимая отправка в Telegram)
  };

  // Продакшен-sweep реестра задач (§20): без периодической чистки терминальные задачи
  // копятся в памяти gateway бесконечно. Снимается в close().
  const taskSweep = setInterval(() => brain.tasks.sweep(Date.now()), 5 * 60_000);
  taskSweep.unref?.();

  // Регистрация плагина WebSocket до объявления маршрутов.
  void app.register(fastifyWebsocket);

  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (connection) => {
      // @fastify/websocket v11: первый аргумент — это сам WebSocket (ws.WebSocket).
      const socket = connection as unknown as RawWs;
      onConnection(socket, config, registry, providers, brain, log);
    });
    // Канал расширения (Chrome). Своя WS, отдельно от клиентского /ws (другой протокол).
    instance.get("/ext", { websocket: true }, (connection) => {
      const ws = connection as unknown as RawWs;
      const sock: ExtSocket = { send: (d) => ws.send(d), close: () => ws.close() };
      extBridge.attach(sock);
      ws.on("message", (raw: unknown) => extBridge.handleMessage(rawToText(raw)));
      ws.on("close", () => extBridge.detach(sock));
      ws.on("error", () => extBridge.detach(sock));
    });
  });

  // DEV-триггер для проверки руки в браузере: POST /ext/telegram {to,text}.
  app.post("/ext/telegram", async (req) => {
    const body = (req.body ?? {}) as { to?: string; text?: string };
    if (!extBridge.connected) return { ok: false, error: "расширение не подключено" };
    try {
      const data = await extBridge.telegramSend(String(body.to ?? ""), String(body.text ?? ""));
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // DEV-триггер: перечитать распакованное расширение с диска (chrome.runtime.reload),
  // чтобы подхватить правки background.js без ручного ↻ в chrome://extensions.
  app.post("/ext/reload", async () => {
    if (!extBridge.connected) return { ok: false, error: "расширение не подключено" };
    try {
      const data = await extBridge.request({ type: "reload" }, 5_000);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

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

  return {
    app,
    registry,
    async listen() {
      await loadProfile(); // §8/§11: помним имя/факты пользователя между запусками
      await dynamicTools.load(); // §8+: выученные инструменты доступны с первой сессии
      void acks.warm(); // §11: прегенерим пул дворецких фраз в фоне (сбой — остаёмся на seed)
      await app.listen({ port: config.port, host: config.host });
      log.info("gateway слушает", { host: config.host, port: config.port });
    },
    async close() {
      clearInterval(taskSweep);
      registry.teardownAll();
      await app.close();
      log.info("gateway остановлен");
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

    // До handshake принимаем только client.hello.
    if (!handshakeDone) {
      if (env.type !== "client.hello") {
        log.warn("кадр до handshake — игнор", { type: env.type });
        return;
      }
      clearTimeout(handshakeTimer);
      ctx = doHandshake(env as Envelope<Hello>, sock, ws, config, registry, providers, brain, log);
      handshakeDone = ctx !== null;
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
    if (ctx) {
      ctx.heartbeat.stop();
      ctx.voice.dispose();
      ctx.disposeAgent(); // §20: пометить сессию закрытой + снять незавершённые фоновые задачи
      forgetClientContext(ctx.session.sessionId);
      brain.warmth.forget(ctx.session.sessionId); // §15: не копим тёплость мёртвых сессий
      // Сессию НЕ удаляем сразу: оставляем для resume (§5). teardown по close
      // оставляем реестру/GC — здесь только heartbeat и in-flight отклоним через teardown
      // при превышении окна resume. Для M0 — снимаем сразу.
      registry.remove(ctx.session.sessionId);
      log.info("соединение закрыто", { sessionId: ctx.session.sessionId });
    }
  });

  ws.on("error", (err: Error) => {
    log.warn("ws error", err.message);
  });
}

/** Выполнить handshake и поднять сессию (§5). Возвращает контекст или null. */
function doHandshake(
  env: Envelope<Hello>,
  sock: SessionSocket,
  ws: RawWs,
  config: ServerConfig,
  registry: SessionRegistry,
  providers: VoiceProviders,
  brain: BrainProviders,
  log: Logger,
): SessionContext | null {
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

  // M0: аутентификация по token — заглушка (один пользователь, §0).
  // TODO(§13): валидировать token, извлечь userId. Пока — seed dev-юзер (UUID,
  // иначе запросы к episodic_memory.user_id::uuid падают).
  const userId = "00000000-0000-0000-0000-000000000001";

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

  // Онбординг (§11): на свежую (не возобновлённую) сессию Джарвис здоровается
  // голосом и спрашивает, как обращаться. На resume — молчит (уже знакомы).
  if (!resumed) startOnboarding(ctx, session, log);

  return ctx;
}

/** Приветствие (§11): по имени, если знаем (профиль), иначе спрашиваем как обращаться. */
function greeting(): string {
  const name = getProfile().displayName;
  return name
    ? `Добрый день, ${name}. Джарвис к вашим услугам.`
    : "Добрый день, сэр. Джарвис к вашим услугам. Как мне к вам обращаться?";
}

function startOnboarding(ctx: SessionContext, session: Session, log: Logger): void {
  // Небольшая задержка — чтобы renderer успел подписаться на speak.chunk/transcript.
  const t = setTimeout(() => {
    try {
      // Приветствие ТОЛЬКО озвучивается (ambient). НЕ шлём ui.display/transcript —
      // иначе на каждое переподключение копится карточка-спам (НЕ чат-бот, §концепт).
      ctx.voice.speak(greeting());
      log.info("онбординг: приветствие произнесено");
    } catch (e) {
      log.warn("онбординг не удался", e instanceof Error ? e.message : String(e));
    }
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
