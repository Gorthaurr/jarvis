/**
 * Durable-хранилище наблюдений (watch). JSON-файл `data/watches.json` (как reminders.json) — переживает
 * рестарт без БД-миграций. Атомарная запись (tmp→rename), чтобы fire-and-forget вызовы не побили JSON.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir as defaultDataDir } from "../../paths.js";
import type { Watch } from "./watch.js";

const log: Logger = createLogger("watch:store");

export class WatchStore {
  private items: Watch[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly dir: string;

  constructor(dataDir = defaultDataDir()) { // §универсальность: JARVIS_DATA_DIR (инсталлер) → иначе cwd/data
    this.dir = dataDir;
    this.path = join(dataDir, "watches.json");
  }

  /** Загрузить с диска (на старте). Безопасно при отсутствии файла. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Watch[];
      this.items = Array.isArray(parsed) ? parsed : [];
      log.info("наблюдения загружены", { count: this.items.length });
    } catch {
      this.items = [];
    }
  }

  /** Активные наблюдения (по которым считаем следующий due). */
  active(): Watch[] {
    return this.items.filter((w) => w.status === "active");
  }

  /** Активные наблюдения пользователя/сессии (для watch_list). */
  list(filter?: { sessionId?: string; userId?: string }): Watch[] {
    return this.items
      .filter((w) => w.status === "active")
      .filter((w) => !filter?.sessionId || w.sessionId === filter.sessionId)
      .filter((w) => !filter?.userId || w.userId === filter.userId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Watch | undefined {
    return this.items.find((w) => w.id === id);
  }

  /** Записи с НЕдоставленным уведомлением (сработали офлайн), любого статуса — для доставки при подключении. */
  withPendingNotify(userId: string): Watch[] {
    return this.items.filter((w) => w.userId === userId && w.pendingNotify !== undefined);
  }

  add(w: Watch): void {
    this.items.push(w);
    this.persist();
  }

  /** Сохранить изменения записи (lastCheckAt/lastValue/status/firedAt/lastNotifiedSummary) на диск. */
  update(w: Watch): void {
    if (!this.items.includes(w)) {
      const idx = this.items.findIndex((x) => x.id === w.id);
      if (idx >= 0) this.items[idx] = w;
      else return;
    }
    this.persist();
  }

  /** Снять наблюдение (по id, если активно). Возвращает снятую запись или null. */
  cancel(id: string): Watch | null {
    const w = this.get(id);
    if (!w || w.status !== "active") return null;
    w.status = "cancelled";
    this.persist();
    return w;
  }

  /** Убрать давно завершённые/снятые из файла (гигиена). Активные не трогаем. */
  prune(now: number, keepMs = 24 * 3600_000): void {
    const before = this.items.length;
    this.items = this.items.filter((w) => w.status === "active" || now - (w.firedAt ?? w.createdAt) < keepMs);
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
      log.warn("не удалось сохранить наблюдения", e instanceof Error ? e.message : String(e));
    }
  }
}
