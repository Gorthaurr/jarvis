/**
 * Эпизодическая (долговременная) память (§8).
 *
 * pgvector-хранилище фактов/предпочтений/событий с семантическим поиском (§1, §8).
 * Эмбеддинги — IEmbeddingProvider. Две реализации:
 *  - PgVectorEpisodicMemory — прод (Postgres+pgvector), схема §13;
 *  - InMemoryEpisodicMemory — dev/тесты без БД (косинус в памяти процесса).
 * Фабрика выбирает по наличию DATABASE_URL.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";
import type { IEmbeddingProvider } from "../integrations/openai-embeddings.js";

const log: Logger = createLogger("episodic");

/** Тип эпизода (§13: kind). */
export type EpisodeKind = "preference" | "fact" | "event";

export interface Episode {
  id: string;
  userId: string;
  kind: EpisodeKind;
  text: string;
  /** unix ms. */
  ts: number;
  salience?: number;
}

/** Результат поиска: эпизод + косинусная близость [0,1]. */
export interface EpisodeHit {
  episode: Episode;
  score: number;
}

export interface EpisodicMemory {
  search(userId: string, queryText: string, k: number): Promise<EpisodeHit[]>;
  write(episode: Omit<Episode, "id">): Promise<void>;
}

/** Косинусная близость двух векторов. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** pgvector-литерал: [0.1,0.2,...]. */
function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}

/** Прод: Postgres + pgvector (схема §13). Без БД деградирует в []/no-op. */
export class PgVectorEpisodicMemory implements EpisodicMemory {
  constructor(private readonly embedder: IEmbeddingProvider) {}

  async search(userId: string, queryText: string, k: number): Promise<EpisodeHit[]> {
    const vec = await this.embedder.embed(queryText);
    if (!vec) return [];
    const res = await query(
      `select id, user_id, kind, text,
              extract(epoch from created_at) * 1000 as ts,
              salience,
              1 - (embedding <=> $2::vector) as score
         from episodic_memory
        where user_id = $1 and stale = false and embedding is not null
        order by embedding <=> $2::vector
        limit $3`,
      [userId, toVectorLiteral(vec), k],
    );
    if (!res) return [];
    return res.rows.map((r) => ({
      episode: {
        id: String(r.id),
        userId: String(r.user_id),
        kind: String(r.kind) as EpisodeKind,
        text: String(r.text),
        ts: Number(r.ts),
        salience: r.salience == null ? undefined : Number(r.salience),
      },
      score: Number(r.score),
    }));
  }

  async write(episode: Omit<Episode, "id">): Promise<void> {
    const vec = await this.embedder.embed(episode.text);
    const res = await query(
      `insert into episodic_memory (user_id, kind, text, salience, embedding)
       values ($1, $2, $3, $4, $5::vector)`,
      [
        episode.userId,
        episode.kind,
        episode.text,
        episode.salience ?? 0.5,
        vec ? toVectorLiteral(vec) : null,
      ],
    );
    if (!res) log.debug("episodic.write no-op (нет БД)");
  }
}

/** Dev/тесты: косинусный поиск в памяти процесса. */
export class InMemoryEpisodicMemory implements EpisodicMemory {
  private readonly store: Array<{ episode: Episode; vec: number[] }> = [];
  private seq = 0;

  constructor(private readonly embedder: IEmbeddingProvider) {}

  async search(userId: string, queryText: string, k: number): Promise<EpisodeHit[]> {
    const vec = await this.embedder.embed(queryText);
    if (!vec) return [];
    return this.store
      .filter((e) => e.episode.userId === userId)
      .map((e) => ({ episode: e.episode, score: cosine(vec, e.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async write(episode: Omit<Episode, "id">): Promise<void> {
    const vec = await this.embedder.embed(episode.text);
    this.seq += 1;
    this.store.push({
      episode: { ...episode, id: `mem-${this.seq}` },
      vec: vec ?? [],
    });
  }

  /** Размер хранилища (диагностика тестов). */
  get size(): number {
    return this.store.length;
  }
}

/** Фабрика: при наличии БД — pgvector, иначе in-memory. */
export function createEpisodicMemory(
  embedder: IEmbeddingProvider,
  hasDatabase: boolean,
): EpisodicMemory {
  if (hasDatabase) {
    log.info("эпизодическая память: pgvector");
    return new PgVectorEpisodicMemory(embedder);
  }
  log.info("эпизодическая память: in-memory (нет DATABASE_URL)");
  return new InMemoryEpisodicMemory(embedder);
}
