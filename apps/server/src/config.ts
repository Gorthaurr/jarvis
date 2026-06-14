/**
 * Конфигурация сервера (§4, §7).
 *
 * Всё читается через env-хелперы @jarvis/shared. Секреты опциональны:
 * без ключей соответствующие интеграции работают в стаб-режиме (§17, M0),
 * сервер при этом поднимается и обслуживает gateway.
 */
import { PROTOCOL_VERSION } from "@jarvis/protocol";
import {
  DEFAULT_MODELS,
  type LogLevel,
  type Tier,
  env,
  envInt,
  envOptional,
} from "@jarvis/shared";

export interface ServerConfig {
  /** TCP-порт Fastify. */
  readonly port: number;
  readonly host: string;
  readonly nodeEnv: string;
  readonly logLevel: LogLevel;
  /** Мажор протокола, которым представляется сервер (§5). */
  readonly protocolVersion: number;
  /** Строка подключения к Postgres; undefined → БД-операции no-op (§13). */
  readonly databaseUrl: string | undefined;

  /** Модели по тирам (§7). id берётся из env, иначе дефолт. */
  readonly models: Record<Exclude<Tier, "tier0">, string>;
  /** Ключи интеграций — опциональны (без них стаб-режим). */
  readonly anthropicApiKey: string | undefined;
  /** Base URL Anthropic/шлюза (proxyapi.ru и т.п.); undefined → прямой Anthropic. */
  readonly anthropicBaseUrl: string | undefined;
  /** TTL prompt-кеша Anthropic (§15): "5m" дефолт, "1h" extended. */
  readonly anthropicCacheTtl: "5m" | "1h";
  readonly openaiApiKey: string | undefined;
  readonly embeddingModel: string;
  readonly embeddingDim: number;

  /** Голос (§10) — без ключей провайдеры работают в mock-режиме. */
  readonly deepgramApiKey: string | undefined;
  /** STT-провайдер (§10): 'deepgram'|'whisper'|'mock'; undefined → авто (whisper без ключа). */
  readonly sttProvider: string | undefined;
  /** Модель локального Whisper (transformers.js), если STT=whisper. */
  readonly whisperModel: string;
  readonly elevenLabsApiKey: string | undefined;
  readonly elevenLabsVoiceId: string | undefined;

  /** Веб-знания (§12) — без ключа web.search отдаёт []. */
  readonly braveApiKey: string | undefined;

  /** Биллинг (§14). */
  readonly defaultSpendCap: number;
}

/** Собрать конфиг из process.env один раз на старте. */
export function loadConfig(): ServerConfig {
  return {
    port: envInt("PORT", 8787),
    host: env("HOST", "0.0.0.0"),
    nodeEnv: env("NODE_ENV", "development"),
    logLevel: normalizeLogLevel(envOptional("LOG_LEVEL")),
    protocolVersion: envInt("PROTOCOL_VERSION", PROTOCOL_VERSION),
    databaseUrl: envOptional("DATABASE_URL"),

    models: {
      haiku: env("TIER1_MODEL", DEFAULT_MODELS.haiku),
      sonnet: env("TIER2_MODEL", DEFAULT_MODELS.sonnet),
      fable: env("TIER3_MODEL", DEFAULT_MODELS.fable),
    },
    anthropicApiKey: envOptional("ANTHROPIC_API_KEY"),
    anthropicBaseUrl: envOptional("ANTHROPIC_BASE_URL"),
    anthropicCacheTtl: env("ANTHROPIC_CACHE_TTL", "5m") === "1h" ? "1h" : "5m",
    openaiApiKey: envOptional("OPENAI_API_KEY"),
    embeddingModel: env("EMBEDDING_MODEL", "text-embedding-3-small"),
    embeddingDim: envInt("EMBEDDING_DIM", 1536),

    deepgramApiKey: envOptional("DEEPGRAM_API_KEY"),
    sttProvider: envOptional("STT_PROVIDER"),
    whisperModel: env("WHISPER_MODEL", "Xenova/whisper-base"),
    elevenLabsApiKey: envOptional("ELEVENLABS_API_KEY"),
    elevenLabsVoiceId: envOptional("ELEVENLABS_VOICE_ID"),

    braveApiKey: envOptional("BRAVE_SEARCH_API_KEY"),

    defaultSpendCap: Number.parseFloat(env("DEFAULT_SPEND_CAP", "50.00")),
  };
}

const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

function normalizeLogLevel(raw: string | undefined): LogLevel {
  if (raw && VALID_LEVELS.has(raw)) return raw as LogLevel;
  return "info";
}
