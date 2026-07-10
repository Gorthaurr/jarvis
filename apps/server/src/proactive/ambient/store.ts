/**
 * Durable память «уже сообщённого» для ambient-движка: ключи сигналов, о которых уже уведомили (чтобы НЕ
 * повторять об одном событии). JSON `data/ambient-seen.json`, атомарно (tmp→rename). Переживает рестарт —
 * иначе после деплоя Джарвис снова прокричал бы про все «непрочитанные»/«счета».
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataDir as defaultDataDir } from "../../paths.js";

const log: Logger = createLogger("ambient:store");

interface SeenEntry {
  key: string;
  at: number;
}

export class AmbientSeenStore {
  private seen: SeenEntry[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly dir: string;
  /** TTL ключа: через сколько «забыть» сообщённое (событие может повториться легитимно — напр. новый счёт). */
  private readonly ttlMs: number;

  constructor(dataDir = defaultDataDir(), ttlMs = 14 * 24 * 3600_000) {
    this.dir = dataDir;
    this.path = join(dataDir, "ambient-seen.json");
    this.ttlMs = ttlMs;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as SeenEntry[];
      this.seen = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.seen = [];
    }
  }

  /** Уже сообщали об этом ключе (в пределах TTL)? */
  has(key: string): boolean {
    return this.seen.some((e) => e.key === key);
  }

  /** Пометить ключ сообщённым (идемпотентно). */
  mark(key: string, now: number): void {
    if (this.seen.some((e) => e.key === key)) return;
    this.seen.push({ key, at: now });
    this.persist();
  }

  /** Выбросить протухшие ключи (TTL) — чтобы файл не рос и повторное легитимное событие снова прозвучало. */
  prune(now: number): void {
    const before = this.seen.length;
    this.seen = this.seen.filter((e) => now - e.at < this.ttlMs);
    if (this.seen.length !== before) this.persist();
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.seen, null, 2);
    this.writeChain = this.writeChain.then(() => this.doPersist(snapshot));
  }

  private async doPersist(snapshot: string): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.path);
    } catch (e) {
      log.warn("не удалось сохранить ambient-seen", e instanceof Error ? e.message : String(e));
    }
  }
}
