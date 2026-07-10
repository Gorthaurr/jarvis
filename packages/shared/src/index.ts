/**
 * @jarvis/shared — общие типы и утилиты (тиры §7, Result, логгер, env-хелперы).
 */

// Сопоставление имён/получателей кросс-скрипт (Герман↔Herman, §13): recall таблицей, решение — моделью.
export * from "./name-match.js";
// Робастный матч кликабельного элемента по тексту (общий browser_act, §6 Фаза 5): без ложных подстрок.
export * from "./ui-match.js";

/** Тиры маршрутизации моделей (§7). */
export type Tier = "tier0" | "haiku" | "sonnet" | "fable";

export const TIER_MODEL_ENV: Record<Exclude<Tier, "tier0">, string> = {
  haiku: "TIER1_MODEL",
  sonnet: "TIER2_MODEL",
  fable: "TIER3_MODEL",
};

/**
 * Дефолтные id моделей (§7), если env не задан. Тир «haiku» — это СЛОТ дешёвого тира, не привязка к
 * модели Haiku: Haiku забракована (слабая), поэтому дешёвый слот по умолчанию = Sonnet 4.6. Сильный
 * тир (эскалация при застревании) — флагман fable-5. Конкретная установка может переопределить через
 * TIER1/2/3_MODEL (напр. сильный=opus-4-8).
 */
export const DEFAULT_MODELS: Record<Exclude<Tier, "tier0">, string> = {
  // Только Sonnet 4.6 (дешёвый/дефолтный) и Opus 4.8 (сильный/эскалация) — Haiku и Fable НЕ используем
  // (требование владельца). Слоты исторически называются haiku/sonnet/fable, но модели — Sonnet/Opus.
  haiku: "claude-sonnet-4-6",
  sonnet: "claude-sonnet-4-6",
  fable: "claude-opus-4-8",
};

/**
 * «Эффорт» рассуждения по тиру = параметр `thinking` Anthropic (живой зонд 2026-06-24: `effort`/
 * `reasoning_effort` API НЕ принимает; глубину рулит ТОЛЬКО `thinking`). Значения: "off" — без
 * размышления (быстро, для тривиальных ходов); "adaptive" — модель сама решает глубину (оба тира);
 * число N — явный бюджет токенов размышления (`thinking.type=enabled`, ТОЛЬКО Sonnet; на Opus
 * автоконвертится в adaptive, т.к. Opus 4.8 = adaptive-thinking-only). Env JARVIS_TIER{1,2,3}_THINKING.
 */
export type ThinkingEffort = "off" | "adaptive" | number;
export const DEFAULT_TIER_THINKING: Record<Exclude<Tier, "tier0">, ThinkingEffort> = {
  haiku: "off", // самый дешёвый слот — без размышления (быстрые тривиальные ходы)
  sonnet: "adaptive", // дефолт ходов — модель думает по необходимости (умнее, но не тупит на простом)
  fable: "adaptive", // сильный/эскалация (Opus) — глубокое адаптивное размышление
};
export const TIER_THINKING_ENV: Record<Exclude<Tier, "tier0">, string> = {
  haiku: "JARVIS_TIER1_THINKING",
  sonnet: "JARVIS_TIER2_THINKING",
  fable: "JARVIS_TIER3_THINKING",
};
/** Распарсить env-значение эффорта ("off"|"adaptive"|число) → ThinkingEffort, иначе дефолт. */
export function parseThinkingEffort(raw: string | undefined, fallback: ThinkingEffort): ThinkingEffort {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "off" || v === "none" || v === "0") return "off";
  if (v === "adaptive" || v === "auto") return "adaptive";
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 1024 ? n : fallback; // бюджет thinking минимум 1024 (требование API)
}

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

/**
 * Булев флаг из env. true ← "1"|"true"|"yes"|"on" (регистр игнор), иначе fallback.
 * `source` — для тестируемости (можно передать подменённый env вместо process.env).
 */
export function envBool(name: string, fallback = false, source: NodeJS.ProcessEnv = process.env): boolean {
  const v = source[name];
  if (v === undefined || v === "") return fallback;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
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

/**
 * Дополнительный приёмник логов (напр. файл на сервере). shared НЕ знает про fs — сервер регистрирует
 * свой sink через `addLogSink`. Sink получает КАЖДУЮ прошедшую по уровню запись; должен быть fail-safe
 * (не бросать — иначе повалит логирующий код). Уровневая фильтровка та же, что у консоли.
 */
export type LogSink = (entry: { ts: number; level: LogLevel; scope: string; msg: string; meta?: unknown }) => void;
const logSinks: LogSink[] = [];

/** Зарегистрировать приёмник логов (файл/сеть). Возвращает функцию отписки. */
export function addLogSink(sink: LogSink): () => void {
  logSinks.push(sink);
  return () => {
    const i = logSinks.indexOf(sink);
    if (i >= 0) logSinks.splice(i, 1);
  };
}

/** Минимальный структурный логгер. В проде заменить на pino за этим интерфейсом. */
export function createLogger(scope = "jarvis", minLevel: LogLevel = "info"): Logger {
  const emit = (level: LogLevel, msg: string, meta?: unknown) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const line = `[${level.toUpperCase()}] (${scope}) ${msg}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (meta !== undefined) fn(line, meta);
    else fn(line);
    // Дополнительные приёмники (файл и т.п.). Fail-safe: сбой sink не должен ломать вызвавший код.
    if (logSinks.length > 0) {
      const entry = { ts: Date.now(), level, scope, msg, meta };
      for (const sink of logSinks) {
        try {
          sink(entry);
        } catch {
          /* приёмник упал — игнорируем, консоль уже отработала */
        }
      }
    }
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
    if (this.map.size <= this.maxEntries) return;
    // Сперва выметаем просроченные (иначе FIFO вытеснит живую запись раньше мёртвой).
    const t = this.now();
    for (const [k, e] of this.map) {
      if (this.map.size <= this.maxEntries) break;
      if (e.expiresAt <= t) this.map.delete(k);
    }
    // Если всё ещё над лимитом — вытесняем самые старые по порядку вставки.
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

// ── параллелизм (§20: фоновые задачи + аренда ввода) ─────────

/**
 * Честный счётный семафор (FIFO). Ограничивает число одновременно
 * исполняющихся операций — напр., параллельных фоновых задач (§20), чтобы не
 * спамить LLM/CPU. Разрешения передаются ожидающим строго в порядке очереди
 * (без «голодания»). Node однопоточный — гонок за счётчиком нет.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(0, Math.floor(permits));
  }

  /** Забрать разрешение синхронно, если есть. true — забрано (обязателен release). */
  tryAcquire(): boolean {
    if (this.permits > 0) {
      this.permits -= 1;
      return true;
    }
    return false;
  }

  /** Дождаться разрешения. Резолвится, когда вызывающий им владеет. */
  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Дождаться разрешения, но не дольше timeoutMs (Волна 1 §20: GUI-инструмент второй задачи не висит
   * вечно за арендой ввода — по таймауту честная ошибка, решает модель). true — взято (обязателен
   * release); false — таймаут: ожидающий УБРАН из очереди (разрешение не утекает, FIFO остальных цел).
   * timeoutMs ≤ 0 → только мгновенная попытка (эквивалент tryAcquire).
   */
  acquireWithTimeout(timeoutMs: number): Promise<boolean> {
    if (this.tryAcquire()) return Promise.resolve(true);
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i === -1) return; // release уже передал разрешение этому ожидающему — resolve(true) сработал
        this.waiters.splice(i, 1);
        resolve(false);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  /** Вернуть разрешение. Есть ожидающие — передаём первому (FIFO), счётчик не растёт. */
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }

  /** Выполнить fn под одним разрешением (acquire → finally release). */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Свободных разрешений сейчас. */
  get available(): number {
    return this.permits;
  }

  /** Сколько вызывающих стоят в очереди за разрешением. */
  get pending(): number {
    return this.waiters.length;
  }
}

/**
 * Взаимное исключение = семафор на одно разрешение. В Джарвисе — аренда
 * физического ввода (мышь/клавиатура/фокус, §20): команды, трогающие ввод,
 * сериализуются через неё, а независимые задачи бегут параллельно.
 */
export class AsyncMutex extends Semaphore {
  constructor() {
    super(1);
  }

  /** Удерживается ли аренда сейчас (нет свободного разрешения). */
  get locked(): boolean {
    return this.available === 0;
  }
}
