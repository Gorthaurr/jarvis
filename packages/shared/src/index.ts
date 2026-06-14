/**
 * @jarvis/shared — общие типы и утилиты (тиры §7, Result, логгер, env-хелперы).
 */

/** Тиры маршрутизации моделей (§7). */
export type Tier = "tier0" | "haiku" | "sonnet" | "fable";

export const TIER_MODEL_ENV: Record<Exclude<Tier, "tier0">, string> = {
  haiku: "TIER1_MODEL",
  sonnet: "TIER2_MODEL",
  fable: "TIER3_MODEL",
};

/** Дефолтные id моделей (§7), если env не задан. */
export const DEFAULT_MODELS: Record<Exclude<Tier, "tier0">, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  fable: "claude-fable-5",
};

/** Result без исключений — для предсказуемого control-flow в раннере/агенте. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Пауза. Используется для джиттера человеческого конверта (§14) и backoff (§7). */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Человеческий джиттер вокруг базовой задержки (§3 принцип 3, §14). */
export function humanJitter(baseMs: number, spreadMs = baseMs * 0.4): number {
  const delta = (Math.random() * 2 - 1) * spreadMs;
  return Math.max(0, Math.round(baseMs + delta));
}

/** Экспоненциальный backoff с джиттером — для retry недоступности Anthropic (§7). */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return humanJitter(exp, exp * 0.25);
}

// ── env ──────────────────────────────────────────────────────

export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

export function envOptional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

// ── логгер ───────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

/** Минимальный структурный логгер. В проде заменить на pino за этим интерфейсом. */
export function createLogger(scope = "jarvis", minLevel: LogLevel = "info"): Logger {
  const emit = (level: LogLevel, msg: string, meta?: unknown) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const line = `[${level.toUpperCase()}] (${scope}) ${msg}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (meta !== undefined) fn(line, meta);
    else fn(line);
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`, minLevel),
  };
}

/** Стадии латентности голосового пайплайна (§10, quality harness §22). */
export type LatencyStage = "wake" | "stt_first" | "llm_first_token" | "tts_first_chunk" | "audio";

// ── кеш (§15: экономия на платных вызовах) ───────────────────

/** Метрики кеша — для замера эффективности кеширования (§15). */
export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  /** Доля попаданий 0..1. */
  hitRate: number;
}

export interface TtlCacheOptions {
  /** Время жизни записи, мс. */
  ttlMs: number;
  /** Максимум записей (LRU-вытеснение сверх лимита). */
  maxEntries?: number;
  /** «Сейчас» — для тестируемости. */
  now?: () => number;
}

/**
 * Один кеш-примитив на все кеши (DRY, §15): in-memory TTL + LRU + метрики hit/miss.
 * Используется декораторами провайдеров эмбеддингов/web/TTS, чтобы не дублировать
 * логику кеширования в каждом.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses += 1;
      return undefined;
    }
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      this.misses += 1;
      return undefined;
    }
    // LRU: освежаем позицию (перемещаем в конец порядка вставки).
    this.map.delete(key);
    this.map.set(key, e);
    this.hits += 1;
    return e.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
