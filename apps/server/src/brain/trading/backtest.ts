/**
 * ИСТОРИЧЕСКИЕ БАЗОВЫЕ СТАВКИ (§трейдинг: «есть годы статистики — используй их»).
 *
 * Прогноз должен опираться не на тонкий срез, а на то, КАК ИСТОРИЧЕСКИ разрешались похожие ситуации.
 * Берём длинную историю свечей → для ТЕКУЩЕГО состояния RSI смотрим: что было дальше (через `horizonBars`)
 * в исторических случаях того же RSI-бакета. Сравниваем с безусловной базой (любой бар) → виден ли ПЕРЕВЕС.
 *
 * Чистая функция (тест без сети). Это ОПИСАТЕЛЬНАЯ статистика прошлого, НЕ гарантия будущего и НЕ совет.
 */
import { macdHistSeries, rsiSeries, smaSeries } from "./indicators.js";

/** RSI-бакет текущего состояния (для условной выборки). */
function rsiBucket(rsi: number): { lo: number; hi: number; label: string } {
  if (rsi < 30) return { lo: 0, hi: 30, label: "RSI<30 (перепроданность)" };
  if (rsi < 45) return { lo: 30, hi: 45, label: "RSI 30–45 (слабость)" };
  if (rsi < 55) return { lo: 45, hi: 55, label: "RSI 45–55 (нейтрально)" };
  if (rsi < 70) return { lo: 55, hi: 70, label: "RSI 55–70 (сила)" };
  return { lo: 70, hi: 101, label: "RSI>70 (перекупленность)" };
}

/** Результат базовых ставок. */
export interface BaseRateResult {
  bars: number;
  horizonBars: number;
  currentRsi: number;
  bucket: string;
  /** Сколько исторических баров попало в тот же RSI-бакет. */
  samples: number;
  /** Доля случаев роста через horizonBars при таком RSI [0..1]. */
  upRate: number;
  /** Средняя доходность через horizonBars при таком RSI, %. */
  avgReturnPct: number;
  /** Безусловная доля роста (любой бар) — база для сравнения. */
  baselineUpRate: number;
  baselineAvgPct: number;
  /** Перевес условной вероятности над базой, процентные пункты (×100). null если выборка мала. */
  edgePp: number | null;
  /** ТЕКУЩИЙ тренд: цена ≥ SMA50 (для трендового фильтра — «не идти против тренда»). */
  trendUp: boolean;
}

/**
 * Базовые ставки для ТЕКУЩЕГО RSI по истории закрытий. horizonBars — на сколько баров вперёд смотрим.
 * Возвращает null, если истории слишком мало для осмысленной статистики.
 */
export function conditionalBaseRate(closes: readonly number[], horizonBars = 1): BaseRateResult | null {
  const h = Math.max(1, Math.floor(horizonBars));
  if (closes.length < 60 + h) return null;
  const rsis = rsiSeries(closes, 14);
  const last = rsis[rsis.length - 1];
  if (last == null) return null;
  const bucket = rsiBucket(last);
  const sma50 = smaSeries(closes, 50);
  const smaLast = sma50[sma50.length - 1];
  const trendUp = smaLast == null ? true : closes[closes.length - 1]! >= smaLast;

  let bUp = 0;
  let bN = 0;
  let bSum = 0; // безусловная база
  let cUp = 0;
  let cN = 0;
  let cSum = 0; // при текущем RSI-бакете
  for (let i = 0; i < closes.length - h; i += 1) {
    const ret = ((closes[i + h]! - closes[i]!) / closes[i]!) * 100;
    bN += 1;
    bSum += ret;
    if (ret > 0) bUp += 1;
    const ri = rsis[i];
    if (ri != null && ri >= bucket.lo && ri < bucket.hi) {
      cN += 1;
      cSum += ret;
      if (ret > 0) cUp += 1;
    }
  }
  const upRate = cN > 0 ? cUp / cN : 0;
  const baselineUpRate = bN > 0 ? bUp / bN : 0;
  return {
    bars: closes.length,
    horizonBars: h,
    currentRsi: last,
    bucket: bucket.label,
    samples: cN,
    upRate,
    avgReturnPct: cN > 0 ? cSum / cN : 0,
    baselineUpRate,
    baselineAvgPct: bN > 0 ? bSum / bN : 0,
    // перевес считаем только при достаточной выборке (иначе шум)
    edgePp: cN >= 20 ? (upRate - baselineUpRate) * 100 : null,
    trendUp,
  };
}

/** Базовая ставка по СВЯЗКЕ факторов (RSI-зона + тренд vs SMA50 + знак MACD-гистограммы). */
export interface MultiFactorResult {
  /** Текущая связка-сетап словами. */
  setup: string;
  samples: number;
  upRate: number;
  avgReturnPct: number;
  baselineUpRate: number;
  /** Перевес над базой, п.п. (×100). null если выборка <15 (специфичный сетап = меньше совпадений). */
  edgePp: number | null;
}

/**
 * Базовые ставки по СВЯЗКЕ сигналов (как реально рассуждает трейдер): берём бары, где ОДНОВРЕМЕННО совпали
 * RSI-зона + положение к SMA50 + знак MACD-гистограммы, как СЕЙЧАС → что было дальше. Специфичнее RSI-only:
 * выборка меньше, но релевантнее. null — мало истории. Описательная статистика прошлого, НЕ гарантия.
 */
export function multiFactorBaseRate(closes: readonly number[], horizonBars = 1): MultiFactorResult | null {
  const h = Math.max(1, Math.floor(horizonBars));
  if (closes.length < 80 + h) return null;
  const rsis = rsiSeries(closes, 14);
  const smas = smaSeries(closes, 50);
  const hists = macdHistSeries(closes);
  const li = closes.length - 1;
  const rsiNow = rsis[li];
  const smaNow = smas[li];
  const histNow = hists[li];
  if (rsiNow == null || smaNow == null || histNow == null) return null;
  const b = rsiBucket(rsiNow);
  const trendUp = closes[li]! >= smaNow; // цена выше SMA50
  const macdUp = histNow > 0;

  let bUp = 0;
  let bN = 0;
  let cUp = 0;
  let cN = 0;
  let cSum = 0;
  for (let i = 0; i < closes.length - h; i += 1) {
    const ret = ((closes[i + h]! - closes[i]!) / closes[i]!) * 100;
    bN += 1;
    if (ret > 0) bUp += 1;
    const ri = rsis[i];
    const si = smas[i];
    const hi = hists[i];
    if (ri == null || si == null || hi == null) continue;
    if (ri >= b.lo && ri < b.hi && closes[i]! >= si === trendUp && hi > 0 === macdUp) {
      cN += 1;
      cSum += ret;
      if (ret > 0) cUp += 1;
    }
  }
  const upRate = cN > 0 ? cUp / cN : 0;
  const baselineUpRate = bN > 0 ? bUp / bN : 0;
  return {
    setup: `${b.label}, цена ${trendUp ? "выше" : "ниже"} SMA50, MACD-гист ${macdUp ? "плюс" : "минус"}`,
    samples: cN,
    upRate,
    avgReturnPct: cN > 0 ? cSum / cN : 0,
    baselineUpRate,
    edgePp: cN >= 15 ? (upRate - baselineUpRate) * 100 : null,
  };
}
