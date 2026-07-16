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
  DEFAULT_TIER_THINKING,
  type LogLevel,
  TIER_THINKING_ENV,
  type ThinkingEffort,
  type Tier,
  env,
  envBool,
  envInt,
  envOptional,
  parseThinkingEffort,
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
  /** «Эффорт» рассуждения (thinking) по тиру (§7). off|adaptive|число-бюджет. */
  readonly tierThinking: Record<Exclude<Tier, "tier0">, ThinkingEffort>;
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

  /** §6B/B2: строгая верификация токена по auth_tokens (LAN/hosted). Дефолт false — на loopback
   *  токен это ключ партиции, не auth (секрет здесь театр). */
  readonly authStrict: boolean;
  /** §6B/безопасность: явное разрешение не-loopback bind. Дефолт false — иначе listen-гард
   *  принудит 127.0.0.1 (LAN-сосед не должен самопровижнить любой userId, пока auth дремлет). */
  readonly allowRemote: boolean;
}

/** Собрать конфиг из process.env один раз на старте. */
export function loadConfig(): ServerConfig {
  return {
    port: envInt("PORT", 8787),
    // §универсальность/безопасность: по умолчанию ТОЛЬКО loopback (клиент+расширение на той же
    // машине идут на localhost/127.0.0.1). 0.0.0.0 без auth = LAN-сосед исполняет команды (аудит).
    // Мульти-девайс (тонкий клиент на телефоне) → выставить HOST=0.0.0.0 ТОЛЬКО вместе с auth (Фаза 6B).
    host: env("HOST", "127.0.0.1"),
    nodeEnv: env("NODE_ENV", "development"),
    logLevel: normalizeLogLevel(envOptional("LOG_LEVEL")),
    protocolVersion: envInt("PROTOCOL_VERSION", PROTOCOL_VERSION),
    databaseUrl: envOptional("DATABASE_URL"),

    models: {
      haiku: env("TIER1_MODEL", DEFAULT_MODELS.haiku),
      sonnet: env("TIER2_MODEL", DEFAULT_MODELS.sonnet),
      fable: env("TIER3_MODEL", DEFAULT_MODELS.fable),
    },
    // «Эффорт» рассуждения по тиру (= параметр thinking Anthropic). Env JARVIS_TIER{1,2,3}_THINKING:
    // off | adaptive | <число-бюджет>. Дефолт: дешёвый слот off (быстро), Sonnet/Opus adaptive (умно).
    tierThinking: {
      haiku: parseThinkingEffort(envOptional(TIER_THINKING_ENV.haiku), DEFAULT_TIER_THINKING.haiku),
      sonnet: parseThinkingEffort(envOptional(TIER_THINKING_ENV.sonnet), DEFAULT_TIER_THINKING.sonnet),
      fable: parseThinkingEffort(envOptional(TIER_THINKING_ENV.fable), DEFAULT_TIER_THINKING.fable),
    },
    anthropicApiKey: envOptional("ANTHROPIC_API_KEY"),
    anthropicBaseUrl: envOptional("ANTHROPIC_BASE_URL"),
    anthropicCacheTtl: env("ANTHROPIC_CACHE_TTL", "5m") === "1h" ? "1h" : "5m",
    openaiApiKey: envOptional("OPENAI_API_KEY"),
    embeddingModel: env("EMBEDDING_MODEL", "text-embedding-3-small"),
    // Канон размерности эмбеддингов (§1): 384 = нативная у локальной e5-small И усечённая у OpenAI
    // text-embedding-3-small (dimensions=384). Один столбец pgvector(384) обслуживает оба провайдера.
    embeddingDim: envInt("EMBEDDING_DIM", 384),

    deepgramApiKey: envOptional("DEEPGRAM_API_KEY"),
    sttProvider: envOptional("STT_PROVIDER"),
    whisperModel: env("WHISPER_MODEL", "Xenova/whisper-base"),
    elevenLabsApiKey: envOptional("ELEVENLABS_API_KEY"),
    elevenLabsVoiceId: envOptional("ELEVENLABS_VOICE_ID"),

    braveApiKey: envOptional("BRAVE_SEARCH_API_KEY"),

    // Месячный потолок трат SpendGuard (§14). Дефолт $300 для владельца-одиночки на СВОЁМ ключе Anthropic:
    // прежние $50 (мультитенант-задел) реально выбивались за месяц (июль-2026: расход $77 > $50 → КАЖДАЯ
    // задача мгновенно отбивалась «достигнут лимит»). $300 — страховка от runaway-цикла, не помеха работе;
    // переопредели DEFAULT_SPEND_CAP в .env под свой бюджет. Битый env → NaN → дефолт (потолок не отключаем).
    defaultSpendCap: (() => {
      const n = Number.parseFloat(env("DEFAULT_SPEND_CAP", "300.00"));
      return Number.isFinite(n) && n > 0 ? n : 300;
    })(),

    authStrict: envBool("JARVIS_AUTH_STRICT"),
    allowRemote: envBool("JARVIS_ALLOW_REMOTE"),
  };
}

const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

function normalizeLogLevel(raw: string | undefined): LogLevel {
  if (raw && VALID_LEVELS.has(raw)) return raw as LogLevel;
  return "info";
}
