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

/** Окно resume (§5): сколько держим сессию ЖИВОЙ после дисконнекта, чтобы reconnect восстановил диалог. */
const RESUME_GRACE_MS = 120_000;

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  /** Отложенные удаления (грейс-окно resume): sessionId → таймер. Reconnect отменяет таймер. */
  private readonly pendingRemoval = new Map<string, ReturnType<typeof setTimeout>>();

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
        this.cancelPendingRemoval(resumeSessionId); // отменяем грейс-удаление — сессия снова в строю
        existing.rebind(socket);
        log.info("resume сессии (история диалога восстановлена)", { sessionId: resumeSessionId });
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

  /**
   * Дисконнект (§5): НЕ убиваем сессию сразу, а держим RESUME_GRACE_MS — чтобы reconnect (сетевой
   * блип/перезапуск клиента) восстановил историю диалога. Истёк грейс без reconnect → remove().
   * Это лечит «Джарвис забыл, о чём говорили» после каждого обрыва WS.
   */
  scheduleRemove(sessionId: string, graceMs = RESUME_GRACE_MS): void {
    if (!this.sessions.has(sessionId) || this.pendingRemoval.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.pendingRemoval.delete(sessionId);
      this.remove(sessionId);
    }, graceMs);
    if (typeof timer === "object" && "unref" in timer) (timer as { unref?: () => void }).unref?.();
    this.pendingRemoval.set(sessionId, timer);
    log.info("сессия в resume-окне (удалю, если не вернётся)", { sessionId, graceMs });
  }

  private cancelPendingRemoval(sessionId: string): void {
    const timer = this.pendingRemoval.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingRemoval.delete(sessionId);
    }
  }

  /** Снять сессию с учёта и освободить ресурсы. */
  remove(sessionId: string): void {
    this.cancelPendingRemoval(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.teardown();
    this.sessions.delete(sessionId);
    log.info("сессия удалена", { sessionId });
  }

  /** Закрыть все сессии (graceful shutdown). */
  teardownAll(): void {
    for (const timer of this.pendingRemoval.values()) clearTimeout(timer);
    this.pendingRemoval.clear();
    for (const s of this.sessions.values()) s.teardown();
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Все активные сессии (для dev-инструментов: послать реальный ActionCommand в клиент). */
  all(): Session[] {
    return [...this.sessions.values()];
  }
}
