/**
 * Эпизодическая (долговременная) память (§8) — интерфейс + стаб.
 *
 * В проде: pgvector-хранилище эпизодов с эмбеддингами (§1, §8); поиск —
 * семантический по запросу. Эмбеддинги считает IEmbeddingProvider (integrations).
 *
 * M0/стаб: без ключей эмбеддинга и без БД search() возвращает []. write() —
 * best-effort в pg, no-op если БД недоступна. Реальный retrieval — TODO(M2).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { IEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { query } from "../db/pool.js";

const log: Logger = createLogger("episodic");

/** Эпизод памяти — единица записи/поиска. */
export interface Episode {
  id: string;
  userId: string;
  /** Текст эпизода (что произошло/было сказано). */
  text: string;
  /** unix ms. */
  ts: number;
  /** Метаданные источника (тип события, ссылки). */
  meta?: Record<string, unknown>;
}

/** Результат поиска: эпизод + косинусная близость [0,1]. */
export interface EpisodeHit {
  episode: Episode;
  score: number;
}

export interface EpisodicMemory {
  /** Семантический поиск top-k эпизодов по запросу. */
  search(userId: string, queryText: string, k: number): Promise<EpisodeHit[]>;
  /** Записать эпизод (считает эмбеддинг и сохраняет). */
  write(episode: Omit<Episode, "id">): Promise<void>;
}

/**
 * Реализация поверх pg+pgvector. Без эмбеддера/БД деградирует в no-op/[].
 */
export class PgVectorEpisodicMemory implements EpisodicMemory {
  constructor(private readonly embedder: IEmbeddingProvider) {}

  async search(userId: string, queryText: string, k: number): Promise<EpisodeHit[]> {
    const vec = await this.embedder.embed(queryText);
    if (!vec) {
      log.debug("эмбеддер недоступен — search → []");
      return [];
    }
    // TODO(M2): реальный pgvector-запрос:
    //   select ... order by embedding <=> $1 limit $2.
    const res = await query(
      `select id, user_id, text, extract(epoch from at) * 1000 as ts, meta
         from episodic_memory
        where user_id = $1
        order by embedding <=> $2::vector
        limit $3`,
      [userId, toVectorLiteral(vec), k],
    );
    if (!res) return []; // БД недоступна — пусто, не падаем (§17 M0).
    return res.rows.map((r) => ({
      episode: {
        id: String(r.id),
        userId: String(r.user_id),
        text: String(r.text),
        ts: Number(r.ts),
        meta: (r.meta as Record<string, unknown>) ?? undefined,
      },
      score: 0, // TODO(M2): возвращать 1 - distance.
    }));
  }

  async write(episode: Omit<Episode, "id">): Promise<void> {
    const vec = await this.embedder.embed(episode.text);
    const res = await query(
      `insert into episodic_memory (user_id, text, at, meta, embedding)
       values ($1, $2, to_timestamp($3 / 1000.0), $4, $5::vector)`,
      [
        episode.userId,
        episode.text,
        episode.ts,
        JSON.stringify(episode.meta ?? {}),
        vec ? toVectorLiteral(vec) : null,
      ],
    );
    if (!res) log.debug("episodic.write no-op (нет БД/эмбеддера)");
  }
}

/** pgvector-литерал: [0.1,0.2,...]. */
function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.join(",")}]`;
}
