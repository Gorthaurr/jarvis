/**
 * АВТО-ПРЕДИКТОР (§трейдинг: набрать выборку за ЧАСЫ, прогнозировать ТОЛЬКО где есть статистика).
 *
 * Фоновый цикл: каждые N минут сканирует вотчлист (крипта 24/7), по каждому инструменту/таймфрейму берёт
 * ИСТОРИЧЕСКУЮ базовую ставку (backtest) и делает прогноз ТОЛЬКО если есть перевес + достаточная выборка —
 * в сторону, которую история favorит. Горизонт = бар таймфрейма (15м/1ч) → быстрая сверка → выборка за часы.
 *
 * ПРАВИЛО-БАЗНЫЙ (направление из базовой ставки), БЕЗ LLM → бесплатно (не жжёт Anthropic-кредиты). Дедуп в
 * PredictionStore не плодит дубли открытых. Это проверка «держится ли исторический перевес вне выборки».
 * ⚠️ прогнозы в одном режиме коррелированы (не вполне независимая статистика) — честно держим в уме.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import type { BaseRateResult } from "./backtest.js";
import type { TradeExpert } from "./expert.js";
import type { Direction, Market, Prediction, TradingService } from "./index.js";
import { type CandleSignal, patternBias } from "./patterns.js";
import type { MarketStructure } from "./structure.js";

const log: Logger = createLogger("auto-predict");

/** Комбинированный сигнал инструмента (price action + база) — один проход по свечам. */
export interface SetupSignal {
  symbol: string;
  market: Market;
  interval: string;
  price: number;
  structure: MarketStructure;
  patterns: CandleSignal[];
  relVolume: number | null;
  baseRate: BaseRateResult | null;
}

/** Один кандидат вотчлиста. */
export interface WatchItem {
  symbol: string;
  market: Market;
  tf: string;
}

export interface AutoPredictorConfig {
  userId: string;
  watch: WatchItem[];
  intervalMs: number;
  /** Минимум исторических совпадений сетапа, чтобы доверять перевесу. */
  minSamples: number;
  /** upRate ≥ → ставим вверх; upRate ≤ (1−порог) → вниз; между → НЕТ края, пропускаем. */
  minUpRate: number;
  /** Минимальная сумма факторов конфлюэнсии для входа (база/паттерн/уровень/объём). */
  minScore: number;
  /** «У уровня» — цена в пределах этого % от поддержки/сопротивления. */
  levelPct: number;
}

/**
 * Решение по базовой ставке (чистая функция): направление с перевесом или null (нет статистики/края).
 * ТРЕНДОВЫЙ ФИЛЬТР (фикс «18% за 2ч»): наивная RSI-ставка = mean-reversion, её убивает тренд (87 шортов
 * против растущего рынка). Поэтому НЕ идём ПРОТИВ тренда: «вверх» только при trendUp, «вниз» только при !trendUp.
 */
export function decideFromBaseRate(
  bt: { upRate: number; samples: number; trendUp?: boolean; combo: { upRate: number; samples: number } | null },
  cfg: Pick<AutoPredictorConfig, "minSamples" | "minUpRate">,
): { direction: Direction; reason: string } | null {
  // предпочитаем СВЯЗКУ (специфичнее), если у неё хватает выборки; иначе RSI-only
  const useCombo = bt.combo != null && bt.combo.samples >= cfg.minSamples;
  const upRate = useCombo ? bt.combo!.upRate : bt.upRate;
  const samples = useCombo ? bt.combo!.samples : bt.samples;
  if (samples < cfg.minSamples) return null; // нет статистики — не гадаем
  let dir: Direction | null = null;
  if (upRate >= cfg.minUpRate) dir = "up";
  else if (upRate <= 1 - cfg.minUpRate) dir = "down";
  if (!dir) return null; // ~50/50 — края нет
  // трендовый фильтр: не торгуем против тренда (если тренд известен)
  if (bt.trendUp === true && dir === "down") return null;
  if (bt.trendUp === false && dir === "up") return null;
  const pct = dir === "up" ? upRate : 1 - upRate;
  return { direction: dir, reason: `история ${dir === "up" ? "вверх" : "вниз"} ${(pct * 100).toFixed(0)}% за ${samples}, по тренду` };
}

/**
 * КОНФЛЮЭНС-РЕШЕНИЕ по полноценному сетапу (price action, фикс «только RSI»): режим (тренд/диапазон) задаёт
 * направление, дальше суммируем факторы — база + свечной паттерн + цена у уровня + объём. Паттерн ПРОТИВ →
 * вход отменяется. Входим только если факторов ≥ minScore. Это «цена у поддержки + бычье поглощение + по
 * тренду», а не один индикатор.
 */
export function decideSetup(
  sig: SetupSignal,
  cfg: Pick<AutoPredictorConfig, "minSamples" | "minUpRate" | "minScore" | "levelPct">,
): { direction: Direction; reason: string } | null {
  const { structure, patterns, relVolume, baseRate, price } = sig;
  const nearSupport = structure.support != null && (price - structure.support) / price >= 0 && (price - structure.support) / price <= cfg.levelPct;
  const nearResistance = structure.resistance != null && (structure.resistance - price) / price >= 0 && (structure.resistance - price) / price <= cfg.levelPct;

  // 1) Направление по РЕЖИМУ: тренд → по тренду; диапазон → от ближайшего края (иначе пропуск).
  let dir: Direction;
  let regime: string;
  if (structure.trend === "up") {
    dir = "up";
    regime = "тренд↑";
  } else if (structure.trend === "down") {
    dir = "down";
    regime = "тренд↓";
  } else if (nearSupport && !nearResistance) {
    dir = "up";
    regime = "диапазон, у поддержки";
  } else if (nearResistance && !nearSupport) {
    dir = "down";
    regime = "диапазон, у сопротивления";
  } else {
    return null; // середина диапазона / нет структуры — не лезем
  }

  const want: "bull" | "bear" = dir === "up" ? "bull" : "bear";
  const pb = patternBias(patterns);
  if (pb !== "neutral" && pb !== want) return null; // свечной сигнал ПРОТИВ направления — отмена

  let score = 0;
  const reasons: string[] = [regime];
  // база (историческая вероятность; связку трендом/паттерном уже дают структура и свечи выше)
  if (baseRate && baseRate.samples >= cfg.minSamples) {
    if (dir === "up" && baseRate.upRate >= cfg.minUpRate) {
      score += 1;
      reasons.push(`база ↑${(baseRate.upRate * 100).toFixed(0)}%/${baseRate.samples}`);
    } else if (dir === "down" && baseRate.upRate <= 1 - cfg.minUpRate) {
      score += 1;
      reasons.push(`база ↓${((1 - baseRate.upRate) * 100).toFixed(0)}%/${baseRate.samples}`);
    }
  }
  // паттерн в сторону
  if (pb === want) {
    score += 1;
    reasons.push(`свеча ${patterns.find((p) => p.bias === want)?.name ?? want}`);
  }
  // цена у нужного уровня
  if (dir === "up" && nearSupport) {
    score += 1;
    reasons.push("у поддержки");
  } else if (dir === "down" && nearResistance) {
    score += 1;
    reasons.push("у сопротивления");
  }
  // объём
  if (relVolume != null && relVolume >= 1.2) {
    score += 0.5;
    reasons.push(`объём ${relVolume.toFixed(1)}×`);
  }

  if (score >= cfg.minScore) return { direction: dir, reason: reasons.join(", ") };
  return null;
}

/** Длительность бара таймфрейма в мс (горизонт прогноза). */
function tfMs(tf: string): number {
  const m: Record<string, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
  return m[tf] ?? 900_000;
}

/** Старший таймфрейм для фильтра тренда: прогноз на TF сверяем с трендом более старшего TF. */
const HIGHER_TF: Record<string, string> = { "5m": "1h", "15m": "4h", "1h": "4h", "4h": "1d", "1d": "1w" };

/**
 * Согласован ли прогноз со СТАРШИМ трендом (чистая функция, фикс «всё шорты в растущем рынке»):
 * НЕ идём против тренда старшего ТФ. up-тренд → только лонг; down-тренд → только шорт; range/неизв. — не мешает.
 */
export function alignsWithHigherTrend(direction: Direction, htfTrend: string): boolean {
  if (htfTrend === "up") return direction === "up";
  if (htfTrend === "down") return direction === "down";
  return true;
}

export class AutoPredictor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly svc: TradingService,
    private readonly cfg: AutoPredictorConfig,
    /** СЛОЙ 2: LLM-эксперт. Есть → отобранные сетапы эскалируются ему (стоп/тейк/пас); нет → правило-базный прогноз направления. */
    private readonly expert?: TradeExpert,
  ) {}

  start(): void {
    if (this.timer) return;
    log.info("авто-предиктор запущен", { watch: this.cfg.watch.length, intervalMs: this.cfg.intervalMs, minSamples: this.cfg.minSamples });
    void this.tick(); // первый прогон сразу
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Один проход: сверить истёкшие + по каждому кандидату прогноз ТОЛЬКО при историческом перевесе. */
  async tick(): Promise<void> {
    if (this.running) return; // не наслаиваем проходы
    this.running = true;
    try {
      await this.svc.resolvePredictions(this.cfg.userId).catch(() => undefined);
      let made = 0;
      for (const w of this.cfg.watch) {
        try {
          // уже есть ОТКРЫТЫЙ прогноз по этому инструменту+горизонту → не дублируем (и не тратим эксперта на тот же сетап)
          if (this.svc.openPredictionExists(this.cfg.userId, w.symbol, w.market, tfMs(w.tf))) continue;
          const sig = await this.svc.setupSignal(w.symbol, { market: w.market, interval: w.tf, horizonBars: 1 });
          if (!sig) continue;
          const d = decideSetup(sig, this.cfg); // дешёвый ПРЕД-СКРИН: конфлюэнсия price action, не один RSI
          if (!d) continue;
          // ФИЛЬТР СТАРШЕГО ТРЕНДА (фикс «всё шорты в растущем рынке»): не открываем против тренда старшего ТФ.
          const htfInterval = HIGHER_TF[w.tf];
          let htfTrend: string | undefined;
          if (htfInterval) {
            htfTrend = await this.svc
              .analyze(w.symbol, { market: w.market, interval: htfInterval })
              .then((a) => a.structure.trend as string)
              .catch(() => undefined);
            if (htfTrend && !alignsWithHigherTrend(d.direction, htfTrend)) continue; // против старшего тренда — пропуск
          }
          let p: Prediction;
          if (this.expert) {
            // СЛОЙ 2: отобранный сетап эскалируем эксперту (сверка с базой знаний → стоп+тейк по R:R). Пас → пропуск.
            const analysis = await this.svc.analyze(w.symbol, { market: w.market, interval: w.tf }).catch(() => null);
            if (!analysis) continue;
            const dec = await this.expert.decide({
              symbol: w.symbol,
              market: w.market,
              interval: w.tf,
              entryPrice: sig.price,
              facts: analysis.summary,
              atr: analysis.indicators.atr14,
              support: analysis.structure.support,
              resistance: analysis.structure.resistance,
              screenReason: d.reason,
              baseRate: sig.baseRate ? { upRate: sig.baseRate.upRate, samples: sig.baseRate.samples } : null,
              higherTf: htfInterval,
              higherTrend: htfTrend,
              change24hPct: analysis.quote.changePct,
            });
            if (!dec || !dec.act) continue;
            p = await this.svc.predict(this.cfg.userId, {
              symbol: w.symbol,
              market: w.market,
              direction: dec.direction,
              horizonMs: tfMs(w.tf),
              stopPrice: dec.stopPrice,
              targetPrice: dec.targetPrice,
              rationale: `эксперт (${w.tf}, conf ${(dec.confidence * 100).toFixed(0)}%): ${dec.rationale}`,
            });
          } else {
            // прежний путь: правило-базный прогноз направления (без LLM, без стопа)
            p = await this.svc.predict(this.cfg.userId, {
              symbol: w.symbol,
              market: w.market,
              direction: d.direction,
              horizonMs: tfMs(w.tf),
              rationale: `авто (${w.tf}): ${d.reason}`,
            });
          }
          // dedup в record вернёт существующий открытый → считаем только реально новые
          if (Date.now() - p.createdAt < 5_000) made += 1;
        } catch (e) {
          log.debug("авто-прогноз пропущен", { symbol: w.symbol, tf: w.tf, err: e instanceof Error ? e.message : String(e) });
        }
      }
      if (made > 0) log.info("авто-предиктор: новые прогнозы по перевесу", { made });
    } finally {
      this.running = false;
    }
  }
}

/** Собрать конфиг из env (универсально). Выключен, пока JARVIS_AUTO_PREDICT≠1. */
export function autoPredictorConfigFromEnv(userId: string): AutoPredictorConfig | null {
  if (process.env.JARVIS_AUTO_PREDICT !== "1") return null;
  const csv = (v: string | undefined, dflt: string): string[] => (v ?? dflt).split(",").map((s) => s.trim()).filter(Boolean);
  const symbols = csv(process.env.JARVIS_AUTO_PREDICT_SYMBOLS, "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT");
  // Горизонты: ДЛИННЫЕ по умолчанию (4ч/1д) — на коротких движение не перебивает комиссию (см. урок 15m/1h).
  const tfs = csv(process.env.JARVIS_AUTO_PREDICT_TFS, "4h,1d");
  // Крипто-ПЕРПЫ (market=crypto_fut, Binance fapi): плечевой вектор. Деф пусто. Прогноз направления ≈ спот,
  // но net учтёт фандинг; РЕАЛЬНОЕ плечо — выбор слоя исполнения, не прогноза.
  const fut = csv(process.env.JARVIS_AUTO_PREDICT_FUT_SYMBOLS, "");
  // Акции МосБиржи (market=tinkoff): отдельные ТФ — деф ТОЛЬКО 1д (интрадей на тарифе 0.6% = cost-trap).
  const moex = csv(process.env.JARVIS_AUTO_PREDICT_MOEX_SYMBOLS, "");
  const moexTfs = csv(process.env.JARVIS_AUTO_PREDICT_MOEX_TFS, "1d");
  const watch: WatchItem[] = [];
  for (const symbol of symbols) for (const tf of tfs) watch.push({ symbol, market: "crypto", tf });
  for (const symbol of fut) for (const tf of tfs) watch.push({ symbol, market: "crypto_fut", tf });
  for (const symbol of moex) for (const tf of moexTfs) watch.push({ symbol, market: "tinkoff", tf });
  return {
    userId,
    watch,
    intervalMs: Math.max(60_000, Number.parseInt(process.env.JARVIS_AUTO_PREDICT_INTERVAL_MS ?? "", 10) || 300_000),
    minSamples: Math.max(5, Number.parseInt(process.env.JARVIS_AUTO_PREDICT_MIN_SAMPLES ?? "", 10) || 25),
    minUpRate: (() => {
      const n = Number.parseFloat(process.env.JARVIS_AUTO_PREDICT_MIN_UPRATE ?? "");
      return Number.isFinite(n) && n > 0.5 && n < 1 ? n : 0.55;
    })(),
    minScore: (() => {
      const n = Number.parseFloat(process.env.JARVIS_AUTO_PREDICT_MIN_SCORE ?? "");
      return Number.isFinite(n) && n > 0 ? n : 2;
    })(),
    levelPct: (() => {
      const n = Number.parseFloat(process.env.JARVIS_AUTO_PREDICT_LEVEL_PCT ?? "");
      return Number.isFinite(n) && n > 0 ? n : 0.015;
    })(),
  };
}
