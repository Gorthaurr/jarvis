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
import { forgetClientContext } from "../proactive/salience.js";
import { startHeartbeat } from "./heartbeat.js";
import { SessionRegistry } from "./registry.js";
import { type SessionContext, dispatch, makeSessionContext } from "./router-ws.js";
import type { SessionSocket } from "./session.js";

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

  // Регистрация плагина WebSocket до объявления маршрутов.
  void app.register(fastifyWebsocket);

  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (connection) => {
      // @fastify/websocket v11: первый аргумент — это сам WebSocket (ws.WebSocket).
      const socket = connection as unknown as RawWs;
      onConnection(socket, config, registry, log);
    });
  });

  // health-чек для оркестратора/клиента.
  app.get("/healthz", async () => ({ ok: true, sessions: registry.size }));

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
      ctx = doHandshake(env as Envelope<Hello>, sock, ws, config, registry, log);
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
      forgetClientContext(ctx.session.sessionId);
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
  // TODO(M? §13): валидировать token, извлечь userId.
  const userId = "local-user";

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
  return makeSessionContext(session, heartbeat);
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
