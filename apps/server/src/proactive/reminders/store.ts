/**
 * Durable-хранилище напоминаний (§9). JSON-файл `data/reminders.json` (как profile.json) — переживает
 * рестарт без БД-миграций. Источник истины: абсолютный `fireAt`; таймер (service.ts) — лишь исполнитель.
 *
 * Запись сериализована (atomic tmp→rename), чтобы fire-and-forget вызовы не побили JSON.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir as defaultDataDir } from "../../paths.js";
import type { Reminder } from "./reminder.js";

const log: Logger = createLogger("reminders:store");

export class ReminderStore {
  private items: Reminder[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly dir: string;

  constructor(dataDir = defaultDataDir()) { // §универсальность: JARVIS_DATA_DIR (инсталлер) → иначе cwd/data
    this.dir = dataDir;
    this.path = join(dataDir, "reminders.json");
  }

  /** Загрузить с диска (на старте). Безопасно при отсутствии файла. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Reminder[];
      this.items = Array.isArray(parsed) ? parsed : [];
      log.info("напоминания загружены", { count: this.items.length });
    } catch {
      this.items = [];
    }
  }

  /** Все активные (запланированные, ещё не сработавшие) — для расчёта ближайшего таймера. */
  scheduledPending(): Reminder[] {
    return this.items.filter((r) => r.status === "scheduled" && r.firedAt === undefined);
  }

  /** Ближайшее по времени активное напоминание (или null). */
  nextPending(): Reminder | null {
    return this.scheduledPending().reduce<Reminder | null>((a, r) => (a && a.fireAt <= r.fireAt ? a : r), null);
  }

  /** Сработавшие, но НЕ доставленные (ждут активной озвучки). §6B/B3: фильтр по userId — на reconnect
   *  sessionId НОВЫЙ, поэтому отложенное догоняем по ПОЛЬЗОВАТЕЛЮ, а не сессии (и не утекаем чужому). */
  awaitingDelivery(filter?: { userId?: string }): Reminder[] {
    return this.items.filter(
      (r) =>
        r.status === "scheduled" &&
        r.firedAt !== undefined &&
        (!filter?.userId || r.userId === filter.userId),
    );
  }

  /** Активные напоминания пользователя/сессии (для list_reminders). */
  list(filter?: { sessionId?: string; userId?: string }): Reminder[] {
    return this.items
      .filter((r) => r.status === "scheduled")
      .filter((r) => !filter?.sessionId || r.sessionId === filter.sessionId)
      .filter((r) => !filter?.userId || r.userId === filter.userId)
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  get(id: string): Reminder | undefined {
    return this.items.find((r) => r.id === id);
  }

  add(r: Reminder): void {
    this.items.push(r);
    this.persist();
  }

  /** Снять статус (отметить fired/done/cancelled). Возвращает true, если запись найдена. */
  setStatus(id: string, status: Reminder["status"], firedAt?: number): boolean {
    const r = this.get(id);
    if (!r) return false;
    r.status = status;
    if (firedAt !== undefined) r.firedAt = firedAt;
    this.persist();
    return true;
  }

  /** Отметить «сработало, но пока не доставлено» (нет активной озвучки). */
  markFiredUndelivered(id: string, firedAt: number): void {
    const r = this.get(id);
    if (!r) return;
    r.firedAt = firedAt;
    this.persist();
  }

  /** Отменить по id (если активно). */
  cancel(id: string): boolean {
    const r = this.get(id);
    if (!r || r.status !== "scheduled") return false;
    r.status = "cancelled";
    this.persist();
    return true;
  }

  /** Убрать давно завершённые/отменённые из файла (гигиена). Активные не трогаем. */
  prune(now: number, keepMs = 24 * 3600_000): void {
    const before = this.items.length;
    this.items = this.items.filter((r) => r.status === "scheduled" || now - (r.firedAt ?? r.createdAt) < keepMs);
    if (this.items.length !== before) this.persist();
  }

  /** Дождаться завершения отложенных записей (graceful shutdown / детерминизм тестов). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.items, null, 2);
    this.writeChain = this.writeChain.then(() => this.doPersist(snapshot));
  }

  private async doPersist(snapshot: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.path);
    } catch (e) {
      log.warn("не удалось сохранить напоминания", e instanceof Error ? e.message : String(e));
    }
  }
}
