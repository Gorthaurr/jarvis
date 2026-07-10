/**
 * TradingService (§трейдинг, слой 1: ДАННЫЕ + АНАЛИЗ) — фасад над рыночными данными и индикаторами.
 *
 * ТОЛЬКО ЧТЕНИЕ: котировки, свечи, технический анализ. Денег НЕ двигает. Исполнение ордеров (авто по
 * правилам + лимиты через confirm-гейт + SpendGuard) — отдельный СЛЕДУЮЩИЙ слой, сюда не входит.
 *
 * Анализ — ФАКТИЧЕСКАЯ интерпретация индикаторов (RSI перекуплен/перепродан, цена выше/ниже SMA,
 * импульс MACD), НЕ совет «покупать/продавать» (Джарвис не лицензированный советник, см. persona).
 */
import { type BaseRateResult, type MultiFactorResult, conditionalBaseRate, multiFactorBaseRate } from "./backtest.js";
import { roundTripCostPct } from "./costs.js";
import { atr, ema, macd, type MacdResult, rsi, sma } from "./indicators.js";
import { type CandleSignal, detectCandlePatterns, patternBias } from "./patterns.js";
import { type MarketStructure, analyzeStructure } from "./structure.js";
import type { SetupSignal } from "./auto-predictor.js";
import { type Candle, type IMarketDataProvider, type Market, type Quote } from "./market.js";
import type { Prediction, PredictionInput, PredictionStore, WinRateStats } from "./predictions.js";
import type { TinkoffPosition, TinkoffProvider } from "./tinkoff.js";

export type { Candle, Market, Quote };
export type { CandleSignal } from "./patterns.js";
export type { MarketStructure } from "./structure.js";
export type { Direction, Prediction, PredictionInput, SymbolStat, WinRateStats } from "./predictions.js";
export type { BaseRateResult, MultiFactorResult } from "./backtest.js";
export { roundTripCostPct } from "./costs.js";
export { DEFAULT_RISK_LIMITS, canAdd, clusterOf, positionSize, riskLimitsFromEnv } from "./risk.js";
export { newsQuery } from "./news.js";
export type { OpenPosition, RiskLimits } from "./risk.js";
export type { TinkoffPosition } from "./tinkoff.js";
export { MarketDataProvider, MockMarketDataProvider } from "./market.js";
export { PredictionStore, loadPredictionStore, qualifiedSetups } from "./predictions.js";
export type { QualifiedSetup } from "./predictions.js";
export { TinkoffProvider, makeTinkoffProvider } from "./tinkoff.js";
export { AutoPredictor, alignsWithHigherTrend, autoPredictorConfigFromEnv, decideFromBaseRate, decideSetup } from "./auto-predictor.js";
export type { SetupSignal } from "./auto-predictor.js";
export { TradeExpert } from "./expert.js";
export type { ExpertContext, ExpertDecision } from "./expert.js";
export { simulate, statsOf } from "./sim.js";
export type { Dir, SignalFn, SimOpts, SimStats, SimTrade } from "./sim.js";

/** Сводка технического анализа инструмента. */
export interface Analysis {
  quote: Quote;
  interval: string;
  bars: number;
  indicators: {
    sma20: number | null;
    sma50: number | null;
    ema12: number | null;
    ema26: number | null;
    rsi14: number | null;
    macd: MacdResult | null;
    atr14: number | null;
  };
  /** Свечные паттерны на последней свече (price action). */
  patterns: CandleSignal[];
  /** Структура рынка: тренд по свингам (HH/HL) + уровни. */
  structure: MarketStructure;
  /** Относительный объём последней свечи к среднему (×), null если нет. */
  relVolume: number | null;
  /** Фактические наблюдения (НЕ совет): тренд, паттерны, уровни, перекупленность, импульс. */
  summary: string[];
}

/**
 * Вывести площадку из тикера, если не указана явно. Пары крипты оканчиваются на котируемую валюту
 * (USDT/USDC/BUSD/BTC/ETH) — их в MOEX-тикерах не бывает; иначе считаем MOEX-акцией.
 */
export function inferMarket(symbol: string, explicit?: Market): Market {
  if (explicit) return explicit;
  return /(USDT|USDC|BUSD|FDUSD|BTC|ETH)$/i.test(symbol.trim()) ? "crypto" : "moex";
}

const RESOLVE_BAR_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** Интервал свечей для PATH-сверки прогноза: достаточно мелкий, чтобы внутри окна было ~12–42 бара. */
function pickResolveInterval(windowMs: number): string {
  if (windowMs <= 3_600_000) return "5m"; // ≤1ч → 5м
  if (windowMs <= 14_400_000) return "15m"; // ≤4ч → 15м
  if (windowMs <= 86_400_000) return "1h"; // ≤1д → 1ч
  if (windowMs <= 604_800_000) return "4h"; // ≤1нед → 4ч
  return "1d";
}

export class TradingService {
  constructor(
    private readonly data: IMarketDataProvider,
    private readonly predictions?: PredictionStore,
    private readonly tinkoff?: TinkoffProvider,
  ) {}

  get live(): boolean {
    return this.data.live;
  }

  /** Подключён ли реальный Тинькофф (read-only). */
  get hasTinkoff(): boolean {
    return Boolean(this.tinkoff);
  }

  /** РЕАЛЬНЫЙ портфель Тинькофф (read-only): позиции + суммарная стоимость. Бросает без токена. */
  async portfolio(accountId?: string): Promise<{ accountId: string; positions: TinkoffPosition[]; totalRub: number | null }> {
    if (!this.tinkoff) throw new Error("Tinkoff не подключён — задай TINKOFF_INVEST_TOKEN (read-only) в .env");
    return this.tinkoff.portfolio(accountId);
  }

  /** Цена для записи входа/сверки прогноза. */
  private price = (symbol: string, market: Market): Promise<number> => this.data.quote(symbol, market).then((q) => q.last);

  /**
   * Свечи ОКНА прогноза для PATH-сверки (R-мультипликатор). КЛЮЧЕВОЕ: тянем свечи ИМЕННО окна
   * [createdAt, resolveAt] через `candlesRange` (startTime/endTime), а НЕ «последние N» — иначе, если
   * прогноз дозрел, пока сервер был выключен, окно в прошлом не покрывалось и сверка падала на направление.
   */
  private resolveCandles = async (symbol: string, market: Market, fromMs: number, toMs: number): Promise<readonly Candle[]> => {
    const interval = pickResolveInterval(Math.max(0, toMs - fromMs));
    const barMs = RESOLVE_BAR_MS[interval] ?? 900_000;
    const candles = await this.data.candlesRange(symbol, market, interval, fromMs - barMs, toMs + barMs);
    return candles.filter((c) => c.t >= fromMs - barMs && c.t <= toMs + barMs);
  };

  /**
   * ИСТОРИЧЕСКИЕ БАЗОВЫЕ СТАВКИ: тянем длинную историю и считаем, что было дальше при ТЕКУЩЕМ RSI.
   * horizonBars — на сколько баров вперёд. Бросает, если истории мало.
   */
  async backtest(symbol: string, opts: { market?: Market; interval?: string; horizonBars?: number; limit?: number } = {}): Promise<BaseRateResult & { symbol: string; market: Market; interval: string; combo: MultiFactorResult | null }> {
    const market = inferMarket(symbol, opts.market);
    const interval = opts.interval ?? "1d";
    const closes = (await this.data.candles(symbol, market, interval, opts.limit ?? 500)).map((c) => c.c);
    const r = conditionalBaseRate(closes, opts.horizonBars ?? 1);
    if (!r) throw new Error(`мало истории по «${symbol}» (${closes.length} баров) для базовых ставок`);
    return { symbol: symbol.toUpperCase(), market, interval, ...r, combo: multiFactorBaseRate(closes, opts.horizonBars ?? 1) };
  }

  /**
   * Комбинированный СИГНАЛ инструмента за ОДИН проход по свечам (для авто-предиктора): структура, свечные
   * паттерны, объём, историческая базовая ставка. null — мало истории.
   */
  async setupSignal(symbol: string, opts: { market?: Market; interval?: string; horizonBars?: number } = {}): Promise<SetupSignal | null> {
    const market = inferMarket(symbol, opts.market);
    const interval = opts.interval ?? "1h";
    const candles = await this.data.candles(symbol, market, interval, 500);
    if (candles.length < 60) return null;
    const closes = candles.map((c) => c.c);
    const vols = candles.map((c) => c.v);
    const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
    return {
      symbol: symbol.toUpperCase(),
      market,
      interval,
      price: closes[closes.length - 1]!,
      structure: analyzeStructure(candles.slice(-150)),
      patterns: detectCandlePatterns(candles),
      relVolume: avgVol > 0 ? (vols[vols.length - 1] ?? 0) / avgVol : null,
      baseRate: conditionalBaseRate(closes, opts.horizonBars ?? 1),
    };
  }

  /** Записать ПРОГНОЗ (фиксируем цену входа + круговую издержку площадки). Бросает, если журнал не сконфигурирован. */
  async predict(userId: string, input: PredictionInput): Promise<Prediction> {
    if (!this.predictions) throw new Error("журнал прогнозов не сконфигурирован");
    const entry = await this.price(input.symbol, input.market);
    return this.predictions.record(userId, input, entry, roundTripCostPct(input.market));
  }

  /** Сверить просроченные прогнозы юзера (ленивая авто-сверка): со стопом → path по свечам (R), иначе → по цене. */
  async resolvePredictions(userId: string): Promise<Prediction[]> {
    if (!this.predictions) return [];
    return this.predictions.resolveDue(userId, this.price, this.resolveCandles);
  }

  /** Винрейт юзера (сначала сверяем просроченные, затем считаем). */
  async winRate(userId: string, symbol?: string): Promise<WinRateStats> {
    if (!this.predictions) throw new Error("журнал прогнозов не сконфигурирован");
    await this.resolvePredictions(userId);
    return this.predictions.winRate(userId, symbol);
  }

  /** Список прогнозов юзера (сначала ленивая сверка просроченных). */
  async listPredictions(userId: string, filter: { symbol?: string; status?: Prediction["status"]; limit?: number } = {}): Promise<Prediction[]> {
    if (!this.predictions) return [];
    await this.resolvePredictions(userId);
    return this.predictions.list(userId, filter);
  }

  /** Есть ли уже ОТКРЫТЫЙ прогноз по инструменту+площадке+горизонту (авто-предиктор не плодит дубль одного сетапа, пока он открыт). Синхронно, без сети. */
  openPredictionExists(userId: string, symbol: string, market: Market, horizonMs: number): boolean {
    if (!this.predictions) return false;
    return this.predictions.list(userId, { symbol, status: "open" }).some((p) => p.market === market && p.horizonMs === horizonMs);
  }

  quote(symbol: string, market?: Market): Promise<Quote> {
    return this.data.quote(symbol, inferMarket(symbol, market));
  }

  candles(symbol: string, opts: { market?: Market; interval?: string; limit?: number } = {}): Promise<Candle[]> {
    return this.data.candles(symbol, inferMarket(symbol, opts.market), opts.interval ?? "1d", opts.limit ?? 100);
  }

  /** Полный технический анализ: котировка + индикаторы + фактическая сводка по `limit` свечам. */
  async analyze(symbol: string, opts: { market?: Market; interval?: string; limit?: number } = {}): Promise<Analysis> {
    const market = inferMarket(symbol, opts.market);
    const interval = opts.interval ?? "1d";
    const limit = opts.limit ?? 120;
    const [quote, candles] = await Promise.all([
      this.data.quote(symbol, market),
      this.data.candles(symbol, market, interval, limit),
    ]);
    const closes = candles.map((c) => c.c);
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    const ind = {
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      ema12: ema(closes, 12),
      ema26: ema(closes, 26),
      rsi14: rsi(closes, 14),
      macd: macd(closes),
      atr14: atr(highs, lows, closes, 14),
    };
    const patterns = detectCandlePatterns(candles);
    const structure = analyzeStructure(candles);
    const vols = candles.map((c) => c.v);
    const avgVol = vols.length > 1 ? vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length) : 0;
    const relVolume = avgVol > 0 ? (vols[vols.length - 1] ?? 0) / avgVol : null;
    return {
      quote,
      interval,
      bars: candles.length,
      indicators: ind,
      patterns,
      structure,
      relVolume,
      summary: summarize(quote.last, ind, patterns, structure, relVolume),
    };
  }
}

/** Фактические наблюдения: price action (структура, свечи, объём) + индикаторы (НЕ совет). */
function summarize(price: number, ind: Analysis["indicators"], patterns: CandleSignal[], structure: MarketStructure, relVolume: number | null): string[] {
  const out: string[] = [];
  // Price action — ПЕРВЫМ (структура важнее лагающего индикатора).
  out.push(structure.desc);
  if (patterns.length > 0) out.push(`свечи: ${patterns.map((p) => p.name).join(", ")} (уклон ${patternBias(patterns)})`);
  if (relVolume !== null) out.push(`объём ${relVolume.toFixed(1)}× к среднему${relVolume >= 1.5 ? " — повышенный (подтверждает движение)" : relVolume <= 0.6 ? " — низкий (слабое участие)" : ""}`);
  if (ind.rsi14 !== null) {
    const z = ind.rsi14 >= 70 ? "перекупленность" : ind.rsi14 <= 30 ? "перепроданность" : "нейтральная зона";
    out.push(`RSI ${ind.rsi14.toFixed(1)} — ${z}`);
  }
  if (ind.sma50 !== null) {
    out.push(`цена ${price >= ind.sma50 ? "выше" : "ниже"} SMA50 (${ind.sma50.toFixed(2)}) — ${price >= ind.sma50 ? "восходящий" : "нисходящий"} контекст`);
  }
  if (ind.sma20 !== null && ind.sma50 !== null) {
    out.push(`SMA20 ${ind.sma20 >= ind.sma50 ? "выше" : "ниже"} SMA50 — ${ind.sma20 >= ind.sma50 ? "краткосрочный импульс вверх" : "краткосрочный импульс вниз"}`);
  }
  if (ind.macd) {
    out.push(`MACD-гистограмма ${ind.macd.histogram >= 0 ? "положительная (бычий импульс)" : "отрицательная (медвежий импульс)"}`);
  }
  if (ind.atr14 !== null) {
    out.push(`ATR14 ${ind.atr14.toFixed(2)} (${((ind.atr14 / price) * 100).toFixed(1)}% от цены) — волатильность`);
  }
  return out;
}
