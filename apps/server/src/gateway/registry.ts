/**
 * Реестр активных сессий (§5).
 *
 * Хранит Session по sessionId и поддерживает resume: при реконнекте клиент
 * присылает resumeSessionId, и если сессия ещё жива — переиспользуем её
 * (in-flight команды сохраняются), иначе создаём новую.
 */
import { newId } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { Session, type SessionSocket } from "./session.js";

const log: Logger = createLogger("registry");

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();

  /**
   * Создать новую сессию или возобновить существующую (§5).
   * @returns пара {session, resumed}.
   */
  createOrResume(
    userId: string,
    socket: SessionSocket,
    resumeSessionId?: string,
  ): { session: Session; resumed: boolean } {
    if (resumeSessionId) {
      const existing = this.sessions.get(resumeSessionId);
      if (existing && existing.userId === userId) {
        existing.rebind(socket);
        log.info("resume сессии", { sessionId: resumeSessionId });
        return { session: existing, resumed: true };
      }
      log.warn("resumeSessionId не найден/чужой — создаём новую", { resumeSessionId });
    }

    const sessionId = newId();
    const session = new Session(sessionId, userId, socket);
    this.sessions.set(sessionId, session);
    log.info("новая сессия", { sessionId, userId });
    return { session, resumed: false };
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Снять сессию с учёта и освободить ресурсы. */
  remove(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.teardown();
    this.sessions.delete(sessionId);
    log.info("сессия удалена", { sessionId });
  }

  /** Закрыть все сессии (graceful shutdown). */
  teardownAll(): void {
    for (const s of this.sessions.values()) s.teardown();
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
