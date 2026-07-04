/**
 * Журнал ПРОГНОЗОВ + ВИНРЕЙТ (§трейдинг, слой 2: «прав он или нет»).
 *
 * Джарвис смотрит инструмент (вкл. фьючи), говорит НАПРАВЛЕНИЕ на горизонт → запись с ценой входа.
 * Когда горизонт истёк — авто-СВЕРКА с реальной ценой: попал/не попал. Копится статистика винрейта —
 * трек-рекорд, на котором потом строится доверие к реальному исполнению. Денег НЕ двигает.
 *
 * Чистая логика (resolveOne/computeWinRate) тестируется без сети/времени; PredictionStore хранит и
 * персистит. Время и цены инъектируются (детерминизм тестов, как в TaskManager).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Logger, createLogger } from "@jarvis/shared";
import type { Candle, Market } from "./market.js";

const log: Logger = createLogger("predict");

export type Direction = "up" | "down";

/** Входные данные прогноза от модели. */
export interface PredictionInput {
  symbol: string;
  market: Market;
  direction: Direction;
  /** Горизонт в миллисекундах (на сколько вперёд прогноз). */
  horizonMs: number;
  /** Целевая цена (тейк-профит) — для R-мультипликатора и path-сверки. */
  targetPrice?: number;
  /** Цена стопа (защитный выход) — задаёт РИСК на сделку (|вход − стоп|), единицу R. */
  stopPrice?: number;
  /** Обоснование (тех.анализ/мысль) — для разбора качества прогнозов. */
  rationale?: string;
}

/** Прогноз в журнале. */
export interface Prediction extends PredictionInput {
  id: string;
  userId: string;
  createdAt: number;
  resolveAt: number;
  entryPrice: number;
  status: "open" | "correct" | "wrong";
  exitPrice?: number;
  resolvedAt?: number;
  /** Фактическое движение в % (со знаком: + рост, − падение). */
  movePct?: number;
  /** Круговая издержка сделки (%, туда-обратно) на момент записи — для расчёта ЧИСТОЙ прибыльности. */
  costPct?: number;
  /** Реализованный R-мультипликатор (прибыль/убыток в единицах риска |вход−стоп|). Только при path-сверке со стопом. */
  rMultiple?: number;
  /** Как закрылся при path-сверке: дошёл до тейка / выбило стопом / истёк горизонт (выход по close). */
  outcome?: "target" | "stop" | "time";
}

/** Статистика по одному инструменту (лидерборд «где угадывает лучше»). */
export interface SymbolStat {
  symbol: string;
  resolved: number;
  correct: number;
  winRate: number;
  /** Средний ЧИСТЫЙ край (после издержек), %. */
  avgNetEdgePct: number;
}

/** Сводная статистика винрейта. */
export interface WinRateStats {
  total: number;
  open: number;
  resolved: number;
  correct: number;
  wrong: number;
  /** Доля попаданий среди разрешённых [0..1]; 0 при отсутствии разрешённых. */
  winRate: number;
  /** Средний «край»: движение в СТОРОНУ прогноза, % (gross, ДО издержек). */
  avgEdgePct: number;
  /** ЧИСТЫЙ винрейт: доля прогнозов, где край ПОБЕДИЛ издержки (netEdge>0) — реальная прибыльность. */
  netWinRate: number;
  /** Средний ЧИСТЫЙ край (gross − комиссия туда-обратно), %. ≤0 = «работаем на брокера». */
  avgNetEdgePct: number;
  /** Сколько прогнозов сверено path-методом со стопом (есть R-мультипликатор) — база для expectancy. */
  rResolved: number;
  /** МАТОЖИДАНИЕ в R (средний rMultiple, gross). Главное табло профи: >0 = система +EV до издержек. */
  expectancyR: number;
  /** Чистое матожидание в R (после издержек в единицах риска). >0 = реально прибыльно. */
  netExpectancyR: number;
  /** Профит-фактор (сумма выигрышей / |сумма проигрышей| в net-R). >1 = прибыльно; Infinity если нет проигрышей. */
  profitFactor: number;
  /** Разбивка по инструментам (лидерборд по чистому краю, по убыванию). */
  bySymbol: SymbolStat[];
}

/** Сетап-кандидат для РЕАЛЬНЫХ денег: статистика + значимость + вердикт «дотянул». */
export interface QualifiedSetup extends SymbolStat {
  /** z-оценка винрейта против 0.5 (|z|≥~2 = значимо). */
  z: number;
  /** Прошёл планку реальных денег: net>0 И выборка ≥ порога И статзначимо. */
  qualified: boolean;
}

/**
 * Вывести ЛУЧШИЕ позиции по результатам теста (мост к реальным деньгам): из разбивки по инструментам
 * оставляем те, где (1) чистый край ПОСЛЕ комиссий > 0, (2) выборка ≥ minResolved, (3) винрейт статзначимо
 * выше 50% (z ≥ minZ). Это и есть «торговать можно только это». Сортировка по чистому краю. Чистая функция.
 */
export function qualifiedSetups(
  stats: readonly SymbolStat[],
  opts: { minResolved?: number; minNetEdgePct?: number; minZ?: number } = {},
): QualifiedSetup[] {
  const minResolved = opts.minResolved ?? 30;
  const minNet = opts.minNetEdgePct ?? 0;
  const minZ = opts.minZ ?? 1.65; // ~95% односторонний; строже — 2.0
  return stats
    .map((s) => {
      const z = s.resolved > 0 ? (s.winRate - 0.5) / (0.5 / Math.sqrt(s.resolved)) : 0;
      return { ...s, z, qualified: s.resolved >= minResolved && s.avgNetEdgePct > minNet && z >= minZ };
    })
    .sort((a, b) => b.avgNetEdgePct - a.avgNetEdgePct);
}

/** Чистый край прогноза: движение в его сторону минус круговая издержка (%, со знаком). */
function netEdgeOf(p: Prediction): number {
  const gross = p.direction === "up" ? (p.movePct ?? 0) : -(p.movePct ?? 0);
  return gross - (p.costPct ?? 0);
}
const avg = (a: readonly number[]): number => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Издержка сделки В ЕДИНИЦАХ РИСКА (R): круговая комиссия % / риск-дистанция % (|вход−стоп|/вход). 0 без стопа. */
function rCostOf(p: Prediction): number {
  if (p.stopPrice == null || p.entryPrice <= 0) return 0;
  const riskPct = (Math.abs(p.entryPrice - p.stopPrice) / p.entryPrice) * 100;
  return riskPct > 0 ? (p.costPct ?? 0) / riskPct : 0;
}
/** Чистый R после издержек (gross R − комиссия, выраженная в R). */
function netROf(p: Prediction): number {
  return (p.rMultiple ?? 0) - rCostOf(p);
}

/** Разрешить ОДИН прогноз по фактической цене (чистая функция). Угадал = цена пошла в сторону прогноза. */
export function resolveOne(p: Prediction, exitPrice: number, now: number): Prediction {
  const movePct = ((exitPrice - p.entryPrice) / p.entryPrice) * 100;
  const wentUp = exitPrice > p.entryPrice;
  const correct = movePct !== 0 && (p.direction === "up" ? wentUp : !wentUp);
  return { ...p, status: correct ? "correct" : "wrong", exitPrice, resolvedAt: now, movePct };
}

/**
 * PATH-сверка по свечам окна (профессиональная, чистая функция): идём по свечам в хронологии и смотрим, что
 * случилось ПЕРВЫМ — выбило стопом (R≈−1), дошло до тейка (R=|тейк−вход|/риск), или истёк горизонт (выход по
 * последнему close, R = движение/риск). Это «сколько R принёс при контролируемом риске», а не «угадал ли
 * направление». Требует stopPrice; без стопа/свечей деградирует на resolveOne по последней цене.
 * Консервативно: при касании стопа И тейка в ОДНОЙ свече считаем, что раньше сработал стоп.
 */
export function resolveByPath(p: Prediction, candles: readonly Candle[], now: number): Prediction {
  const entry = p.entryPrice;
  const stop = p.stopPrice;
  const last = candles.length > 0 ? candles[candles.length - 1]!.c : entry;
  if (stop == null || !Number.isFinite(stop) || stop === entry || candles.length === 0) {
    return resolveOne(p, last, now);
  }
  const long = p.direction === "up";
  const risk = Math.abs(entry - stop);
  const target = p.targetPrice;
  let exitPrice = last;
  let outcome: "target" | "stop" | "time" = "time";
  for (const c of candles) {
    const hitStop = long ? c.l <= stop : c.h >= stop;
    const hitTarget = target != null && (long ? c.h >= target : c.l <= target);
    if (hitStop) {
      exitPrice = stop;
      outcome = "stop";
      break;
    }
    if (hitTarget) {
      exitPrice = target!;
      outcome = "target";
      break;
    }
  }
  const movePct = ((exitPrice - entry) / entry) * 100;
  const gross = long ? exitPrice - entry : entry - exitPrice;
  const rMultiple = gross / risk;
  return { ...p, status: rMultiple > 0 ? "correct" : "wrong", exitPrice, resolvedAt: now, movePct, rMultiple, outcome };
}

/** Источник свечей окна прогноза для path-сверки (инъекция из TradingService). */
export type CandleFn = (symbol: string, market: Market, fromMs: number, toMs: number) => Promise<readonly Candle[]>;

/** Винрейт по набору прогнозов (чистая функция): gross + ЧИСТЫЙ (после издержек) + разбивка по инструментам. */
export function computeWinRate(items: readonly Prediction[]): WinRateStats {
  const resolved = items.filter((p) => p.status !== "open");
  const correct = resolved.filter((p) => p.status === "correct").length;
  const grossEdges = resolved.map((p) => (p.direction === "up" ? (p.movePct ?? 0) : -(p.movePct ?? 0)));
  const netEdges = resolved.map(netEdgeOf);
  const netWins = netEdges.filter((e) => e > 0).length;
  // EXPECTANCY в R — только по прогнозам со стопом (path-сверка дала rMultiple). Это профессиональное табло.
  const rItems = resolved.filter((p) => p.rMultiple != null);
  const grossRs = rItems.map((p) => p.rMultiple ?? 0);
  const netRs = rItems.map(netROf);
  const winsR = netRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const lossR = -netRs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const profitFactor = lossR > 0 ? winsR / lossR : winsR > 0 ? Number.POSITIVE_INFINITY : 0;
  return {
    total: items.length,
    open: items.length - resolved.length,
    resolved: resolved.length,
    correct,
    wrong: resolved.length - correct,
    winRate: resolved.length > 0 ? correct / resolved.length : 0,
    avgEdgePct: avg(grossEdges),
    netWinRate: resolved.length > 0 ? netWins / resolved.length : 0,
    avgNetEdgePct: avg(netEdges),
    rResolved: rItems.length,
    expectancyR: avg(grossRs),
    netExpectancyR: avg(netRs),
    profitFactor,
    bySymbol: symbolBreakdown(resolved),
  };
}

/** Разбивка разрешённых прогнозов по инструментам, отсортированная по ЧИСТОМУ краю (лидерборд). */
function symbolBreakdown(resolved: readonly Prediction[]): SymbolStat[] {
  const groups = new Map<string, Prediction[]>();
  for (const p of resolved) {
    const k = p.symbol.toUpperCase();
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  const out: SymbolStat[] = [];
  for (const [symbol, ps] of groups) {
    const corr = ps.filter((p) => p.status === "correct").length;
    out.push({
      symbol,
      resolved: ps.length,
      correct: corr,
      winRate: ps.length > 0 ? corr / ps.length : 0,
      avgNetEdgePct: avg(ps.map(netEdgeOf)),
    });
  }
  return out.sort((a, b) => b.avgNetEdgePct - a.avgNetEdgePct);
}

/** Цена инструмента (инъекция: из TradingService). */
export type PriceFn = (symbol: string, market: Market) => Promise<number>;

/** Хранилище прогнозов: запись, авто-сверка по горизонту, статистика. Персист на диск (опц.). */
export class PredictionStore {
  private readonly items = new Map<string, Prediction>();
  private seq = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly file?: string,
  ) {
    if (file && existsSync(file)) this.loadDisk(file);
  }

  /** Записать прогноз с зафиксированной ценой входа и КРУГОВОЙ ИЗДЕРЖКОЙ (для чистой прибыльности). */
  record(userId: string, input: PredictionInput, entryPrice: number, costPct = 0): Prediction {
    const t = this.now();
    // ДЕДУП (фикс наложения ходов/rapid-fire): уже есть ОТКРЫТЫЙ прогноз по тому же инструменту+горизонту в
    // окне → не плодим дубль/противоречие (BTC 1h ×3, ETH up и down). Возвращаем существующий. Окно env.
    const dedupMs = Number.parseInt(process.env.JARVIS_PREDICT_DEDUP_MS ?? "", 10) || 120_000;
    for (const p of this.items.values()) {
      if (
        p.userId === userId &&
        p.status === "open" &&
        p.symbol.toUpperCase() === input.symbol.toUpperCase() &&
        p.market === input.market &&
        p.horizonMs === input.horizonMs &&
        t - p.createdAt <= dedupMs
      ) {
        log.debug("прогноз-дубль в окне — возвращаю существующий", { id: p.id, symbol: p.symbol });
        return p;
      }
    }
    this.seq += 1;
    const p: Prediction = {
      ...input,
      id: `pr_${t}_${this.seq}`,
      userId,
      createdAt: t,
      resolveAt: t + Math.max(0, input.horizonMs),
      entryPrice,
      costPct,
      status: "open",
    };
    this.items.set(p.id, p);
    this.save();
    return p;
  }

  /**
   * Сверить все ПРОСРОЧЕННЫЕ открытые прогнозы юзера. Со стопом + candleFn → PATH-сверка по свечам окна
   * (R-мультипликатор); иначе → по фактической цене (направление). Возвращает разрешённые.
   */
  async resolveDue(userId: string, priceFn: PriceFn, candleFn?: CandleFn): Promise<Prediction[]> {
    const now = this.now();
    const due = [...this.items.values()].filter((p) => p.userId === userId && p.status === "open" && p.resolveAt <= now);
    const out: Prediction[] = [];
    for (const p of due) {
      try {
        let resolved: Prediction;
        if (p.stopPrice != null && candleFn) {
          const candles = await candleFn(p.symbol, p.market, p.createdAt, p.resolveAt).catch(() => [] as readonly Candle[]);
          resolved = candles.length > 0 ? resolveByPath(p, candles, now) : resolveOne(p, await priceFn(p.symbol, p.market), now);
        } else {
          resolved = resolveOne(p, await priceFn(p.symbol, p.market), now);
        }
        this.items.set(p.id, resolved);
        out.push(resolved);
      } catch (e) {
        log.debug("сверка прогноза отложена (нет цены)", { id: p.id, err: e instanceof Error ? e.message : String(e) });
      }
    }
    if (out.length > 0) {
      this.save();
      log.info("прогнозы сверены", { userId, resolved: out.length });
    }
    return out;
  }

  /** Список прогнозов юзера (новые первыми), опц. фильтр по символу/статусу. */
  list(userId: string, filter: { symbol?: string; status?: Prediction["status"]; limit?: number } = {}): Prediction[] {
    let arr = [...this.items.values()].filter((p) => p.userId === userId);
    if (filter.symbol) arr = arr.filter((p) => p.symbol.toUpperCase() === filter.symbol!.toUpperCase());
    if (filter.status) arr = arr.filter((p) => p.status === filter.status);
    arr.sort((a, b) => b.createdAt - a.createdAt);
    return filter.limit ? arr.slice(0, filter.limit) : arr;
  }

  /** Статистика винрейта юзера (опц. по символу). */
  winRate(userId: string, symbol?: string): WinRateStats {
    return computeWinRate(this.list(userId, symbol ? { symbol } : {}));
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify([...this.items.values()]), "utf8");
    } catch (e) {
      log.warn("не удалось сохранить прогнозы", e instanceof Error ? e.message : String(e));
    }
  }

  private loadDisk(file: string): void {
    try {
      const arr = JSON.parse(readFileSync(file, "utf8")) as Prediction[];
      for (const p of arr) {
        this.items.set(p.id, p);
        const n = Number.parseInt(p.id.split("_")[2] ?? "0", 10);
        if (Number.isFinite(n) && n > this.seq) this.seq = n;
      }
      log.info("прогнозы загружены", { count: this.items.size });
    } catch (e) {
      log.warn("не удалось загрузить прогнозы", e instanceof Error ? e.message : String(e));
    }
  }
}

/** Фабрика с диск-персистом (data/trading/predictions.json). */
export function loadPredictionStore(dataDir = "data"): PredictionStore {
  return new PredictionStore(() => Date.now(), join(dataDir, "trading", "predictions.json"));
}
