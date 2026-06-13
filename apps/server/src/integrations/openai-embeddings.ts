/**
 * Провайдер эмбеддингов (OpenAI text-embedding-3-small, §1) — интерфейс + стаб.
 *
 * Используется эпизодической памятью (§8) для семантического поиска. Без
 * OPENAI_API_KEY/SDK возвращает null (память деградирует в пустой retrieval).
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("embeddings");

export interface IEmbeddingProvider {
  /** Вектор эмбеддинга текста; null если бэкенд недоступен. */
  embed(text: string): Promise<number[] | null>;
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

  async embed(text: string): Promise<number[] | null> {
    if (!this.live) return null;
    try {
      const client = (await this.getClient()) as {
        embeddings: {
          create(args: { model: string; input: string }): Promise<{
            data: Array<{ embedding: number[] }>;
          }>;
        };
      };
      const resp = await client.embeddings.create({ model: this.model, input: text });
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
  constructor(readonly dim = 1536) {}
  async embed(): Promise<number[] | null> {
    return null;
  }
}
