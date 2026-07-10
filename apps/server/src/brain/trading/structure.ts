/**
 * СТРУКТУРА РЫНКА (§трейдинг: тренд по price action, не по индикатору).
 *
 * Свинг-хаи/лоу (фракталы) → структура тренда: повышающиеся хаи И лоу = восходящий (HH/HL), понижающиеся =
 * нисходящий (LH/LL), иначе диапазон. Плюс ближайшие УРОВНИ поддержки/сопротивления из свингов. Чистые
 * функции на OHLC. Это структурный анализ как у трейдера, а не «RSI сказал».
 */
import type { Candle } from "./market.js";

export interface MarketStructure {
  /** Тренд по структуре: up (HH/HL) / down (LH/LL) / range. */
  trend: "up" | "down" | "range";
  /** Ближайшая поддержка ниже цены (свинг-лоу) или null. */
  support: number | null;
  /** Ближайшее сопротивление выше цены (свинг-хай) или null. */
  resistance: number | null;
  /** Человекочитаемое описание. */
  desc: string;
}

interface Swing {
  i: number;
  p: number;
}

/** Свинг-точки фракталом: бар выше/ниже `lookback` соседей с каждой стороны. */
function swings(candles: readonly Candle[], lookback: number): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = lookback; i < candles.length - lookback; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= lookback; k += 1) {
      if (candles[i]!.h <= candles[i - k]!.h || candles[i]!.h <= candles[i + k]!.h) isHigh = false;
      if (candles[i]!.l >= candles[i - k]!.l || candles[i]!.l >= candles[i + k]!.l) isLow = false;
    }
    if (isHigh) highs.push({ i, p: candles[i]!.h });
    if (isLow) lows.push({ i, p: candles[i]!.l });
  }
  return { highs, lows };
}

/** Структура рынка: тренд по свингам + ближайшие уровни. lookback — ширина фрактала (по умолчанию 2). */
export function analyzeStructure(candles: readonly Candle[], lookback = 2): MarketStructure {
  if (candles.length < 4 * lookback + 1) {
    return { trend: "range", support: null, resistance: null, desc: "недостаточно баров для структуры" };
  }
  const { highs, lows } = swings(candles, lookback);
  const price = candles[candles.length - 1]!.c;

  let trend: MarketStructure["trend"] = "range";
  if (highs.length >= 2 && lows.length >= 2) {
    const h = highs.slice(-2);
    const l = lows.slice(-2);
    const higherHighs = h[1]!.p > h[0]!.p;
    const higherLows = l[1]!.p > l[0]!.p;
    const lowerHighs = h[1]!.p < h[0]!.p;
    const lowerLows = l[1]!.p < l[0]!.p;
    if (higherHighs && higherLows) trend = "up";
    else if (lowerHighs && lowerLows) trend = "down";
  }

  const supports = lows.map((s) => s.p).filter((p) => p < price);
  const resistances = highs.map((s) => s.p).filter((p) => p > price);
  const support = supports.length > 0 ? Math.max(...supports) : null;
  const resistance = resistances.length > 0 ? Math.min(...resistances) : null;

  const trendWord = trend === "up" ? "восходящая (HH/HL)" : trend === "down" ? "нисходящая (LH/LL)" : "диапазон";
  const sr = [
    support != null ? `поддержка ${support.toFixed(2)} (${(((price - support) / price) * 100).toFixed(1)}% ниже)` : null,
    resistance != null ? `сопротивление ${resistance.toFixed(2)} (${(((resistance - price) / price) * 100).toFixed(1)}% выше)` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { trend, support, resistance, desc: `структура ${trendWord}${sr ? `; ${sr}` : ""}` };
}
