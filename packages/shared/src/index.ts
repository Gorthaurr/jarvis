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
