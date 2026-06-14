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
import { AnthropicLlmProvider } from "../integrations/anthropic.js";
import {
  CachingEmbeddingProvider,
  HashEmbeddingProvider,
  OpenAiEmbeddingProvider,
} from "../integrations/openai-embeddings.js";
import { createSttProvider, createTtsProvider } from "../integrations/providers.js";
import { CachingTtsProvider } from "../integrations/tts-cache.js";
import { CachingWebProvider, WebProvider } from "../integrations/web.js";
import { createEpisodicMemory } from "../memory/episodic.js";
import { forgetClientContext } from "../proactive/salience.js";
import { startHeartbeat } from "./heartbeat.js";
import { SessionRegistry } from "./registry.js";
import {
  type BrainProviders,
  type SessionContext,
  type VoiceProviders,
  dispatch,
  makeSessionContext,
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
  const baseEmbedder = config.openaiApiKey
    ? new OpenAiEmbeddingProvider({
        apiKey: config.openaiApiKey,
        model: config.embeddingModel,
        dim: config.embeddingDim,
      })
    : new HashEmbeddingProvider();
  const embedder = new CachingEmbeddingProvider(baseEmbedder);
  const web = new CachingWebProvider(new WebProvider(config.braveApiKey));
  const brain: BrainProviders = {
    llm: new AnthropicLlmProvider({
      apiKey: config.anthropicApiKey,
      cacheTtl: config.anthropicCacheTtl,
      baseUrl: config.anthropicBaseUrl,
    }),
    episodic: createEpisodicMemory(embedder, Boolean(config.databaseUrl)),
    web,
    spend: new SpendGuard({ spendCap: config.defaultSpendCap }),
    models: config.models,
    tasks: new TaskManager(), // общий реестр долгих задач на gateway (§20)
    warmth: new SessionWarmth(), // §15: кешируем префикс только в тёплых сессиях
  };

  // Регистрация плагина WebSocket до объявления маршрутов.
  void app.register(fastifyWebsocket);

  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (connection) => {
      // @fastify/websocket v11: первый аргумент — это сам WebSocket (ws.WebSocket).
      const socket = connection as unknown as RawWs;
      onConnection(socket, config, registry, providers, brain, log);
    });
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
      await app.listen({ port: config.port, host: config.host });
      log.info("gateway слушает", { host: config.host, port: config.port });
    },
    async close() {
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

  // Онбординг (§11): на свежую (не возобновлённую) сессию Джарвис здоровается
  // голосом и спрашивает, как обращаться. На resume — молчит (уже знакомы).
  if (!resumed) startOnboarding(ctx, session, log);

  return ctx;
}

/** Приветствие Джарвиса при запуске (§11). */
const GREETING = "Добрый день, сэр. Джарвис к вашим услугам. Как мне к вам обращаться?";

function startOnboarding(ctx: SessionContext, session: Session, log: Logger): void {
  // Небольшая задержка — чтобы renderer успел подписаться на speak.chunk/transcript.
  const t = setTimeout(() => {
    try {
      session.send("transcript", { text: GREETING, final: true });
      session.send("ui.display", { title: "Джарвис", markdown: GREETING });
      ctx.voice.speak(GREETING);
      log.info("онбординг: приветствие произнесено");
    } catch (e) {
      log.warn("онбординг не удался", e instanceof Error ? e.message : String(e));
    }
  }, 800);
  if (typeof t.unref === "function") t.unref();
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
