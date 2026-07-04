/**
 * Прод-телеметрия агента (наблюдаемость): сбор per-task событий + агрегаты.
 *
 * Замеряем то, что меряют нормальные приложения на КАЖДЫЙ запрос к агенту: токены по типам,
 * стоимость в ДЕНЬГАХ (USD), латентность, число tool-раундов/вызовов инструментов, тир/модель,
 * успех/ошибка. Синглтон-коллектор `metrics` копит события, `snapshot()` отдаёт агрегаты
 * (totals/error-rate/cache hit-rate/перцентили латентности/avg). Чистые функции (estimateCostUsd,
 * percentile, aggregate) тестируются напрямую — без сети и без состояния.
 *
 * Это НЕ биллинг (тот — SpendGuard §14, в нормализованных единицах). Здесь — наблюдаемость в $/мс.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import { dataPath } from "../paths.js";
import { MODEL_PRICING, type TokenUsage, costUsd } from "./pricing.js";

const log: Logger = createLogger("obs:metrics");

export type { TokenUsage } from "./pricing.js";

/**
 * Тариф Opus (USD за 1M токенов) — РЕЭКСПОРТ из единого источника `pricing.ts`. Раньше тут жил
 * хардкод УСТАРЕВШЕГО прайса ($15/$75) и стоимость считалась по Opus НЕЗАВИСИМО от модели хода
 * (Haiku/Sonnet завышались кратно). Теперь источник истины один — см. pricing.ts. Оставлено для
 * читаемости снапшота/тестов; для расчёта звать costUsd(model, usage).
 */
export const OPUS_PRICING_USD_PER_MTOK = MODEL_PRICING.opus;

/** Событие телеметрии за ОДНУ задачу агента (агрегируется в snapshot). */
export interface AgentMetricEvent {
  /** Тир (haiku|sonnet|fable) и id модели — для разреза по моделям. */
  tier: string;
  model: string;
  /** id пользователя — для per-user разреза COGS (опц.: старые вызовы без него агрегируются глобально). */
  userId?: string;
  /** Полное время хода задачи, мс. */
  latencyMs: number;
  /** Число завершённых tool-use раундов (= шагов многошаговой задачи). */
  rounds: number;
  /** Суммарное число вызовов инструментов за задачу. */
  toolCalls: number;
  /** Токены по типам (сумма по всем ходам задачи). */
  usage: TokenUsage;
  /** Успех (true) или провал/ошибка (false) — для error-rate. */
  ok: boolean;
}

/** Агрегаты по типам токенов. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Снимок агрегированной телеметрии (для GET /stats). */
export interface MetricsSnapshot {
  /** Всего записанных запросов (задач). */
  requests: number;
  /** Из них с ошибкой. */
  errors: number;
  /** Доля ошибок (0..1). */
  errorRate: number;
  /** Сумма токенов по типам. */
  tokens: TokenTotals;
  /** Суммарная стоимость всех запросов, USD (по ФАКТИЧЕСКОЙ модели каждого хода). */
  costUsd: number;
  /** Разрез стоимости/числа запросов по id модели — видно вклад Opus vs Sonnet vs Haiku. */
  costByModel: Record<string, { costUsd: number; requests: number }>;
  /** Доля чтения из кеша среди всех ВХОДНЫХ токенов (cache_read / (input+cache_read+cache_creation)), %. */
  cacheHitRatePct: number;
  /** Латентность, мс. */
  latencyMs: { p50: number; p95: number; avg: number };
  /** Среднее число токенов (всех типов) на запрос. */
  tokensPerRequest: number;
}

/**
 * Стоимость одного запроса в USD (чистая функция — тестируется отдельно). Делегирует единому
 * costUsd(model, usage) из pricing.ts. `model` опционален: без него прайсим как Opus (обратная
 * совместимость прежней Opus-only сигнатуры). С реальным id модели — корректный per-model тариф.
 */
export function estimateCostUsd(usage: TokenUsage, model = "claude-opus-default"): number {
  return costUsd(model, usage);
}

/**
 * Перцентиль по массиву чисел (чистая функция, метод «ближайшего ранга»). p — доля [0..1].
 * Пустой вход → 0. Сортирует копию (не мутирует вход). p50 = медиана, p95 = хвост латентности.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  // Ближайший ранг: индекс = ceil(p·N) − 1, в границах [0, N−1].
  const rank = Math.ceil(clamped * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

/**
 * Свести список событий в агрегаты (чистая функция — без состояния, тестируется напрямую).
 * Округления — для читаемого JSON (стоимость до 6 знаков ≈ микроцент, проценты до 1 знака).
 */
export function aggregate(events: readonly AgentMetricEvent[]): MetricsSnapshot {
  const requests = events.length;
  const errors = events.reduce((n, e) => n + (e.ok ? 0 : 1), 0);
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let totalCost = 0;
  const byModel: Record<string, { costUsd: number; requests: number }> = {};
  const latencies: number[] = [];
  for (const e of events) {
    tokens.input += e.usage.inputTokens;
    tokens.output += e.usage.outputTokens;
    tokens.cacheRead += e.usage.cacheReadTokens;
    tokens.cacheCreation += e.usage.cacheCreationTokens;
    // Стоимость по ФАКТИЧЕСКОЙ модели хода (не Opus-blind, как раньше).
    const c = costUsd(e.model, e.usage);
    totalCost += c;
    const bm = (byModel[e.model] ??= { costUsd: 0, requests: 0 });
    bm.costUsd += c;
    bm.requests += 1;
    latencies.push(e.latencyMs);
  }
  const totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
  // Cache hit-rate: какая доля ВХОДНЫХ токенов пришла из кеша (read vs read+input+creation).
  // Выход в знаменатель не включаем — кеш относится только к входу (§15).
  const inputSide = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;
  const costByModel: Record<string, { costUsd: number; requests: number }> = {};
  for (const [m, v] of Object.entries(byModel)) costByModel[m] = { costUsd: round(v.costUsd, 6), requests: v.requests };
  return {
    requests,
    errors,
    errorRate: requests === 0 ? 0 : round(errors / requests, 4),
    tokens,
    costUsd: round(totalCost, 6),
    costByModel,
    cacheHitRatePct: inputSide === 0 ? 0 : round((tokens.cacheRead / inputSide) * 100, 1),
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5)),
      p95: Math.round(percentile(latencies, 0.95)),
      avg: requests === 0 ? 0 : Math.round(latencies.reduce((s, x) => s + x, 0) / requests),
    },
    tokensPerRequest: requests === 0 ? 0 : Math.round(totalTokens / requests),
  };
}

/**
 * Синглтон-коллектор телеметрии. Держит события в кольцевом буфере (не растёт без предела:
 * прод-процесс живёт долго). record() — горячий путь (агента не тормозит), snapshot() — для /stats.
 */
export class MetricsCollector {
  private readonly events: AgentMetricEvent[] = [];
  /** Потолок хранимых событий — окно для перцентилей/агрегатов (env JARVIS_METRICS_WINDOW, деф 1000). */
  private readonly cap: number;
  /** DURABLE JSONL-хвост (аудит 2026-07-02): окно в ОЗУ теряется на рестарт → дописываем каждое событие
   *  строкой в dataDir/logs/metrics.jsonl. Так латентность/стоимость/успех задач переживают деплой и
   *  доступны офлайн-разбору. Включается gateway.listen() (enableJsonl), не в конструкторе (тесты/чистота). */
  private jsonl = false;

  constructor(cap?: number) {
    const n = Number.parseInt(process.env.JARVIS_METRICS_WINDOW ?? "", 10);
    this.cap = cap ?? (Number.isFinite(n) && n >= 10 && n <= 100_000 ? n : 1000);
  }

  /** Включить durable JSONL-хвост (в проде из gateway.listen). Env JARVIS_METRICS_JSONL=0 — выключить. */
  enableJsonl(): void {
    this.jsonl = (process.env.JARVIS_METRICS_JSONL ?? "1") !== "0";
    if (this.jsonl) {
      try {
        mkdirSync(dataPath("logs"), { recursive: true });
      } catch {
        this.jsonl = false; // нет прав/ФС — тихо остаёмся на in-memory окне
      }
    }
  }

  /** Выключить durable-хвост (graceful shutdown/тесты). */
  disableJsonl(): void {
    this.jsonl = false;
  }

  /** Записать событие задачи. При переполнении окна — выталкиваем старейшее (ring-buffer). */
  record(event: AgentMetricEvent): void {
    this.events.push(event);
    if (this.events.length > this.cap) this.events.shift();
    // Durable-хвост: одна JSONL-строка на задачу (fail-safe — сбой ФС не ломает горячий путь агента).
    if (this.jsonl) {
      try {
        const rec = JSON.stringify({ ts: new Date().toISOString(), ...event, costUsd: costUsd(event.model, event.usage) });
        appendFileSync(join(dataPath("logs"), "metrics.jsonl"), rec + "\n");
      } catch {
        /* не критично — окно в ОЗУ и /stats продолжают работать */
      }
    }
  }

  /** Снимок агрегатов по текущему окну событий. */
  snapshot(): MetricsSnapshot {
    return aggregate(this.events);
  }

  /** Сбросить накопленное (для тестов). */
  reset(): void {
    this.events.length = 0;
  }
}

/** Процесс-синглтон: агент пишет сюда, GET /stats читает. */
export const metrics = new MetricsCollector();

// Лог при инициализации модуля — чтобы в проде было видно, что телеметрия включена.
log.debug("телеметрия агента инициализирована");
