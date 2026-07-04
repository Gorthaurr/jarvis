/**
 * Провайдер эмбеддингов (OpenAI text-embedding-3-small, §1) — интерфейс + стаб.
 *
 * Используется эпизодической памятью (§8) для семантического поиска. Без
 * OPENAI_API_KEY/SDK возвращает null (память деградирует в пустой retrieval).
 */
import { type CacheStats, type Logger, TtlCache, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("embeddings");

/**
 * Роль текста для retrieval-моделей с асимметричными префиксами (e5: «query:»/«passage:»).
 * Поиск → "query", сохранение факта → "passage". Провайдеры без префиксов (OpenAI/hash) игнорируют.
 */
export type EmbeddingKind = "query" | "passage";

export interface IEmbeddingProvider {
  /** Вектор эмбеддинга текста; null если бэкенд недоступен. kind — роль для e5-префиксов (деф "query"). */
  embed(text: string, kind?: EmbeddingKind): Promise<number[] | null>;
  readonly dim: number;
  readonly live: boolean;
}

export interface EmbeddingConfig {
  apiKey: string | undefined;
  model: string;
  dim: number;
}

/** Реализация через OpenAI SDK с фоллбэком в null. */
export class OpenAiEmbeddingProvider implements IEmbeddingProvider {
  readonly dim: number;
  readonly live: boolean;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private clientPromise: Promise<unknown> | null = null;

  constructor(cfg: EmbeddingConfig) {
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.dim = cfg.dim;
    this.live = Boolean(cfg.apiKey);
    if (!this.live) {
      log.warn("OPENAI_API_KEY не задан — эмбеддинги в стаб-режиме (null)");
    }
  }

  async embed(text: string, _kind: EmbeddingKind = "query"): Promise<number[] | null> {
    if (!this.live) return null;
    try {
      const client = (await this.getClient()) as {
        embeddings: {
          create(args: { model: string; input: string; dimensions?: number }): Promise<{
            data: Array<{ embedding: number[] }>;
          }>;
        };
      };
      // dimensions: text-embedding-3-* поддерживает усечение размерности → выравниваем с каноном dim
      // (384), чтобы один и тот же столбец pgvector(384) обслуживал и OpenAI, и локальный e5. OpenAI
      // префиксы query/passage НЕ использует — kind игнорируем.
      const resp = await client.embeddings.create({ model: this.model, input: text, dimensions: this.dim });
      return resp.data[0]?.embedding ?? null;
    } catch (e) {
      log.warn("embed failed → null", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  private getClient(): Promise<unknown> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const mod = await import("openai");
      const OpenAI = (mod.default ?? (mod as { OpenAI?: unknown }).OpenAI) as new (
        opts: { apiKey: string },
      ) => unknown;
      return new OpenAI({ apiKey: this.apiKey! });
    })();
    return this.clientPromise;
  }
}

/** Явный стаб-провайдер (для тестов/сред без ключей). */
export class StubEmbeddingProvider implements IEmbeddingProvider {
  readonly live = false;
  constructor(readonly dim = 384) {}
  async embed(_text?: string, _kind?: EmbeddingKind): Promise<number[] | null> {
    return null;
  }
}

/**
 * Детерминированные псевдо-эмбеддинги (bag-of-words хеширование в bucket'ы),
 * для dev/тестов без ключа: похожие тексты дают похожие векторы → косинусный
 * retrieval работает воспроизводимо. НЕ для прода (качество ниже реальной модели).
 */
export class HashEmbeddingProvider implements IEmbeddingProvider {
  readonly live = true; // «живой» в смысле «возвращает вектор», не null
  constructor(readonly dim = 256) {}

  async embed(text: string, _kind?: EmbeddingKind): Promise<number[]> {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const tok of tokens) {
      const h = hashString(tok) % this.dim;
      vec[h] = (vec[h] ?? 0) + 1;
    }
    // L2-нормализация (косинус = скалярное произведение).
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Кеширующий декоратор эмбеддингов (§15): одинаковый текст → один платный вызов.
 * Не кеширует null (транзиентный сбой/стаб — кешировать «нет ответа» нельзя).
 * Ключ — сам текст (запросы retrieval короткие); объём ограничен LRU.
 */
export class CachingEmbeddingProvider implements IEmbeddingProvider {
  readonly dim: number;
  readonly live: boolean;
  private readonly cache: TtlCache<number[]>;

  constructor(
    private readonly inner: IEmbeddingProvider,
    opts: { ttlMs?: number; maxEntries?: number } = {},
  ) {
    this.dim = inner.dim;
    this.live = inner.live;
    this.cache = new TtlCache<number[]>({
      ttlMs: opts.ttlMs ?? 24 * 3_600_000, // сутки — эмбеддинг текста не меняется
      maxEntries: opts.maxEntries ?? 5_000,
    });
  }

  async embed(text: string, kind: EmbeddingKind = "query"): Promise<number[] | null> {
    // Ключ включает размерность И роль (kind): e5 даёт РАЗНЫЕ векторы для query/passage одного текста,
    // а при смене провайдера/модели несовместима и размерность — нельзя путать в кеше. Нормализуем пробелы.
    const key = `${this.dim}:${kind}:${text.trim().replace(/\s+/g, " ")}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const v = await this.inner.embed(text, kind);
    if (v !== null) this.cache.set(key, v);
    return v;
  }

  get stats(): CacheStats {
    return this.cache.stats;
  }
}
