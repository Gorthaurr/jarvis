/**
 * Технические индикаторы (§трейдинг, слой 1: анализ) — ЧИСТЫЕ функции от рядов цен.
 *
 * Без сети/состояния/LLM → детерминированы и полностью покрываются юнит-тестами по эталонным
 * векторам (математика TA: модель НЕ должна считать RSI/MACD «на глаз» — это делает код точно).
 * Недостаточно данных → `null` (честная деградация, НЕ выдуманное число).
 *
 * Это ДАННЫЕ для интерпретации, НЕ инвестиционный совет: индикатор говорит «RSI 72», вывод
 * «покупать ли» — за пользователем (см. persona: Джарвис не лицензированный советник).
 */

/** Простая скользящая средняя (SMA) по последним `period` значениям. */
export function sma(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i]!;
  return sum / period;
}

/**
 * Экспоненциальная скользящая (EMA) — ВЕСЬ ряд. Сид = SMA первых `period`, далее
 * ema_t = price_t·k + ema_(t-1)·(1−k), k = 2/(period+1). Длина результата = values.length−period+1.
 */
export function emaSeries(values: readonly number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = sma(values.slice(0, period), period)!; // сид
  out.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** EMA — последнее значение (или null). */
export function ema(values: readonly number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length > 0 ? s[s.length - 1]! : null;
}

/**
 * RSI по Уайлдеру (период 14 по умолчанию). Нужно ≥ period+1 цен. avgLoss=0 → RSI 100
 * (только рост). Возвращает последнее значение в [0,100] или null.
 */
export function rsi(values: readonly number[], period = 14): number | null {
  if (period <= 0 || values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * RSI по Уайлдеру В КАЖДОМ баре (для исторических базовых ставок/бэктеста). Длина = values.length;
 * первые `period` элементов — null (недостаточно истории). Иначе как {@link rsi}, но весь ряд.
 */
export function rsiSeries(values: readonly number[], period = 14): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (period <= 0 || values.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** SMA в КАЖДОМ баре (скользящее окно). Длина = вход; первые period−1 — null. */
export function smaSeries(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * MACD-ГИСТОГРАММА в каждом баре (линия − сигнальная), выровнено по индексам входа. Первые
 * (slow+signal−2) — null. Для исторических базовых ставок по состоянию MACD.
 */
export function macdHistSeries(values: readonly number[], fast = 12, slow = 26, signal = 9): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (values.length < slow + signal) return out;
  const fastS = emaSeries(values, fast); // out[k] ↔ values[fast-1+k]
  const slowS = emaSeries(values, slow); // out[k] ↔ values[slow-1+k]
  const macdLine: number[] = [];
  const macdValIdx: number[] = [];
  for (let i = slow - 1; i < values.length; i += 1) {
    macdLine.push(fastS[i - (fast - 1)]! - slowS[i - (slow - 1)]!);
    macdValIdx.push(i);
  }
  const sigS = emaSeries(macdLine, signal); // out[k] ↔ macdLine[signal-1+k]
  for (let j = signal - 1; j < macdLine.length; j += 1) {
    out[macdValIdx[j]!] = macdLine[j]! - sigS[j - (signal - 1)]!;
  }
  return out;
}

/** Результат MACD: линия, сигнальная, гистограмма (последние значения). */
export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * MACD (12/26/9 по умолчанию): линия = EMA(fast) − EMA(slow); сигнальная = EMA(9) от линии;
 * гистограмма = линия − сигнальная. Нужно ≥ slow+signal цен; иначе null.
 */
export function macd(values: readonly number[], fast = 12, slow = 26, signal = 9): MacdResult | null {
  if (values.length < slow + signal) return null;
  const fastS = emaSeries(values, fast);
  const slowS = emaSeries(values, slow);
  // Выравниваем по общему хвосту (fast длиннее slow на slow−fast элементов).
  const tail = Math.min(fastS.length, slowS.length);
  const macdLine: number[] = [];
  for (let i = 0; i < tail; i += 1) {
    macdLine.push(fastS[fastS.length - tail + i]! - slowS[slowS.length - tail + i]!);
  }
  const signalS = emaSeries(macdLine, signal);
  if (signalS.length === 0) return null;
  const macdLast = macdLine[macdLine.length - 1]!;
  const signalLast = signalS[signalS.length - 1]!;
  return { macd: macdLast, signal: signalLast, histogram: macdLast - signalLast };
}

/**
 * ATR по Уайлдеру (период 14) — средний истинный диапазон (волатильность). TR =
 * max(high−low, |high−prevClose|, |low−prevClose|). Нужно ≥ period+1 свечей; иначе null.
 */
export function atr(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period = 14,
): number | null {
  const n = closes.length;
  if (n < period + 1 || highs.length !== n || lows.length !== n) return null;
  const trs: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!),
    );
    trs.push(tr);
  }
  // Сид = среднее первых `period` TR, далее сглаживание Уайлдера.
  let a = sma(trs.slice(0, period), period)!;
  for (let i = period; i < trs.length; i += 1) a = (a * (period - 1) + trs[i]!) / period;
  return a;
}
