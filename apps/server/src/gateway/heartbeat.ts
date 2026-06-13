/**
 * Heartbeat соединения (§5).
 *
 * Сервер шлёт ping каждые HEARTBEAT_INTERVAL_MS. Клиент отвечает pong
 * (router вызывает notePong при приходе). Два пропуска подряд
 * (HEARTBEAT_MAX_MISSES) → соединение считается мёртвым, сокет закрывается,
 * клиент инициирует reconnect/resume.
 */
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSES,
} from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { Session } from "./session.js";

const log: Logger = createLogger("heartbeat");

export interface HeartbeatHandle {
  /** Зафиксировать пришедший pong (сбрасывает счётчик пропусков). */
  notePong(): void;
  /** Остановить heartbeat (при close/teardown). */
  stop(): void;
}

/**
 * Запустить heartbeat для сессии.
 * @param onDead вызывается, когда превышен лимит пропусков (закрыть сокет, §5).
 */
export function startHeartbeat(
  session: Session,
  onDead: () => void,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  maxMisses = HEARTBEAT_MAX_MISSES,
): HeartbeatHandle {
  let misses = 0;
  let awaitingPong = false;

  const tick = (): void => {
    if (awaitingPong) {
      // Предыдущий ping остался без pong.
      misses += 1;
      log.debug("пропуск heartbeat", { sessionId: session.sessionId, misses });
      if (misses >= maxMisses) {
        log.warn("heartbeat: лимит пропусков превышен → разрыв", {
          sessionId: session.sessionId,
          misses,
        });
        clearInterval(timer);
        onDead();
        return;
      }
    }
    awaitingPong = true;
    session.send("ping", { ts: Date.now() });
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    notePong(): void {
      awaitingPong = false;
      misses = 0;
      session.lastPongAt = Date.now();
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
