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
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
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
  /** Учёт размера metrics.jsonl в БАЙТАХ (в ОЗУ; −1 = ещё не инициализирован от реального размера файла).
   *  Пишем редко (несколько строк на задачу), поэтому statSync зовём ОДИН раз на сессию (ленивая init),
   *  дальше складываем длины строк — без syscall на каждую запись. */
  private jsonlBytes = -1;
  /** Порог ротации metrics.jsonl по РАЗМЕРУ (байт). Ревью learn-coding-agent 2026-07-15: файл рос без
   *  предела (pruneOldLogs чистит по возрасту ТОЛЬКО server-*.log — file-log.test.ts это фиксирует). Чистить
   *  metrics.jsonl по возрасту НЕЛЬЗЯ: это longitudinal-экономика (/cogs, юнит-экономика), в отличие от шумных
   *  server-логов. Поэтому bound по размеру: >cap → metrics.jsonl.1 (одна прошлая генерация), новый с нуля;
   *  свежие данные целы, диск ограничен ~2×cap. env JARVIS_METRICS_MAX_BYTES (деф 64 МБ, мин 1 МБ). */
  private readonly maxJsonlBytes: number;
  /** Таймер периодической строки здоровья процесса (type:"process_health"); unref, стоп на dispose/тестах. */
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cap?: number, opts?: { maxJsonlBytes?: number }) {
    const n = Number.parseInt(process.env.JARVIS_METRICS_WINDOW ?? "", 10);
    this.cap = cap ?? (Number.isFinite(n) && n >= 10 && n <= 100_000 ? n : 1000);
    const mb = Number.parseInt(process.env.JARVIS_METRICS_MAX_BYTES ?? "", 10);
    // opts.maxJsonlBytes — тест-переопределение (env-клампу не подчиняется, чтобы не писать 1 МБ в тесте).
    this.maxJsonlBytes = opts?.maxJsonlBytes ?? (Number.isFinite(mb) && mb >= 1_000_000 ? mb : 64 * 1024 * 1024);
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

  /** Выключить durable-хвост (graceful shutdown/тесты). Останавливает и таймер здоровья процесса. */
  disableJsonl(): void {
    this.jsonl = false;
    this.stopProcessHealth();
  }

  /**
   * Дописать одну JSONL-строку в metrics.jsonl (fail-safe). ЕДИНЫЙ писатель (DRY: раньше appendFileSync
   * дублировался в record/recordRound/recordMouthToEar). Раз в ROTATE_CHECK_EVERY записей проверяет размер
   * и ротирует по нему (по возрасту НЕ чистим — longitudinal-экономика). Сбой ФС проглатывается: окно в
   * ОЗУ и /stats продолжают работать.
   */
  private appendJsonl(obj: unknown): void {
    if (!this.jsonl) return;
    try {
      const path = join(dataPath("logs"), "metrics.jsonl");
      const line = `${JSON.stringify(obj)}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (this.jsonlBytes < 0) {
        // Первая запись сессии: реальный размер файла (переживший рестарт), дальше считаем в ОЗУ.
        try {
          this.jsonlBytes = statSync(path).size;
        } catch {
          this.jsonlBytes = 0; // файла ещё нет
        }
      }
      // Ротация ДО записи: если добавление строки перевалит cap (и файл не пуст) → сдвигаем в .1, пишем в новый.
      // Счётчик обнуляем ТОЛЬКО при реальном успехе rename (ревью 2026-07-15 #2/#3): если renameSync бросил
      // (Windows — файл держит другой процесс/АВ/индексатор), файл на месте с размером ~cap → оставляем
      // jsonlBytes у порога, тогда условие ротации остаётся истинным и попытка повторяется на СЛЕДУЮЩЕЙ записи
      // (самовосстановление, рост ограничен темпом строки), а не копим ещё целый cap до новой попытки.
      if (this.jsonlBytes > 0 && this.jsonlBytes + bytes > this.maxJsonlBytes && this.rotate(path)) {
        this.jsonlBytes = 0;
      }
      appendFileSync(path, line);
      this.jsonlBytes += bytes;
    } catch {
      /* не критично */
    }
  }

  /** Ротация по размеру: metrics.jsonl → metrics.jsonl.1 (одна прошлая генерация), новый файл пишется с нуля.
   *  unlink прошлой .1 до rename — на Windows renameSync не перезаписывает существующий таргет. Возвращает
   *  true ТОЛЬКО если rename реально удался (иначе счётчик в appendJsonl не сбрасываем — повторим позже). */
  private rotate(path: string): boolean {
    const prev = `${path}.1`;
    try {
      unlinkSync(prev);
    } catch {
      /* прошлой генерации нет — ок */
    }
    try {
      renameSync(path, prev);
      log.info("metrics.jsonl ротирован по размеру", { maxBytes: this.maxJsonlBytes });
      return true;
    } catch {
      return false; // rename не удался (лок/права/гонка) — счётчик не трогаем, повторим на следующей записи
    }
  }

  /**
   * Периодическая durable-строка здоровья процесса (type:"process_health"): rss/heap/uptime/cpu + версия
   * node. Усиливает цель file-log («разбор „вчера оглох / сожрало память" был слеп»): при регрессе памяти/
   * CPU у владельца durable-корреляция во времени. Idempotent, unref (не держит event loop). Пишет ТОЛЬКО
   * при включённом jsonl. Стоп — stopProcessHealth (dispose/тесты). Первую строку эмитит сразу.
   */
  startProcessHealth(intervalMs = 300_000): void {
    if (this.healthTimer || !this.jsonl) return;
    const tick = (): void => {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      this.appendJsonl({
        ts: new Date().toISOString(),
        type: "process_health",
        uptimeSec: Math.round(process.uptime()),
        rssMb: Math.round(mem.rss / 1_048_576),
        heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
        heapTotalMb: Math.round(mem.heapTotal / 1_048_576),
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        node: process.version,
      });
    };
    tick(); // durable-baseline сразу на старте (не ждём первый интервал)
    this.healthTimer = setInterval(tick, intervalMs);
    if (typeof this.healthTimer === "object" && "unref" in this.healthTimer) this.healthTimer.unref?.();
  }

  /** Остановить таймер здоровья процесса (dispose/тесты). Idempotent. */
  stopProcessHealth(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Пер-раундовое событие (Волна 1, 1.8): экономика КАЖДОГО LLM-раунда — durable JSONL-строкой
   * (type:"round"), в ОЗУ-окно агрегатов НЕ попадает (там per-task события). Раньше кеш-промахи и
   * их причины были невидимы (метрики только per-task) — деградации находились археологией по логам.
   */
  recordRound(event: {
    taskId: string;
    round: number;
    tier: string;
    model: string;
    usage: TokenUsage;
    toolNames: readonly string[];
    cacheThrashCause?: string;
  }): void {
    this.appendJsonl({ ts: new Date().toISOString(), type: "round", ...event, costUsd: costUsd(event.model, event.usage) });
  }

  /**
   * Realtime инкремент 0: mouth-to-ear («конец речи пользователя → первый звук РЕАЛЬНО сыгран у клиента»,
   * мс) — durable JSONL-строкой (type:"mouth_to_ear"). Это ГЛАВНАЯ метрика §10; baseline P50/P95 «до уха»
   * считается офлайн-разбором этих строк (переживают деплой). В ОЗУ-окно per-task агрегатов НЕ попадает
   * (иной масштаб события). Пишется ТОЛЬКО для собственного ответа пользовательского хода (проводка в
   * gateway; проактив/фон не тегаются — см. pipeline.onAudioPlayed). Fail-safe: сбой ФС не критичен.
   */
  recordMouthToEar(ms: number, turnSeq: number, userId?: string): void {
    this.appendJsonl({ ts: new Date().toISOString(), type: "mouth_to_ear", ms, turnSeq, ...(userId ? { userId } : {}) });
  }

  /** Записать событие задачи. При переполнении окна — выталкиваем старейшее (ring-buffer). */
  record(event: AgentMetricEvent): void {
    this.events.push(event);
    if (this.events.length > this.cap) this.events.shift();
    // Durable-хвост: одна JSONL-строка на задачу (fail-safe — сбой ФС не ломает горячий путь агента).
    this.appendJsonl({ ts: new Date().toISOString(), ...event, costUsd: costUsd(event.model, event.usage) });
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
