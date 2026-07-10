/**
 * Бэктест-ДВИЖОК (§трейдинг: ПОИСК КРАЯ правилом, не угадайкой LLM).
 *
 * Событийная симуляция: на каждом баре правило (signalFn, видит ТОЛЬКО прошлое) даёт направление → вход по
 * close, стоп = atrMult·ATR от структуры, тейк = rr·риск; идём вперёд по барам пока не выбьет стоп / дойдёт
 * тейк (интрабар по high/low) / истечёт maxHold (выход по close). Сделки НЕ перекрываются. Считаем
 * матожидание в R (gross И net после издержек), винрейт, профит-фактор, макс. просадку.
 *
 * Чистая логика, без сети/LLM → тысячи сделок бесплатно, можно мести грид стратегий и валидировать
 * out-of-sample (walk-forward против переобучения). Look-ahead исключён: сигнал и ATR — на candles[0..i],
 * резолв — на candles[i+1..]. ATR-серия предрасчитана (O(n)).
 */
import { atr } from "./indicators.js";
import type { Candle } from "./market.js";

export type Dir = "up" | "down";
/** Правило: решение на баре i, используя ТОЛЬКО candles[0..i] (или null = нет сигнала). */
export type SignalFn = (candles: readonly Candle[], i: number) => Dir | null;

export interface SimOpts {
  atrPeriod?: number; // период ATR (14)
  atrMultStop?: number; // стоп = N·ATR (1.5)
  rrTarget?: number; // тейк = rr·риск (2.0)
  maxHold?: number; // макс. удержание в барах (24)
  costPct?: number; // круговая издержка %, для net
  warmup?: number; // мин. баров до старта (60)
}

export interface SimTrade {
  i: number;
  dir: Dir;
  entry: number;
  stop: number;
  target: number;
  exitI: number;
  exit: number;
  rMultiple: number;
  netR: number;
  outcome: "target" | "stop" | "time";
}

export interface SimStats {
  trades: number;
  wins: number;
  winRate: number;
  expectancyR: number;
  netExpectancyR: number;
  profitFactor: number;
  maxDrawdownR: number;
}

const avg = (a: readonly number[]): number => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Серия ATR (Wilder) по всем барам: atrSeries[i] — ATR на close бара i (null до прогрева). O(n). */
function atrSeries(candles: readonly Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    tr.push(i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1]!.c), Math.abs(c.l - candles[i - 1]!.c)));
  }
  let a = avg(tr.slice(1, period + 1)); // первый ATR = среднее TR за period
  out[period] = a;
  for (let i = period + 1; i < candles.length; i++) {
    a = (a * (period - 1) + tr[i]!) / period; // сглаживание Уайлдера
    out[i] = a;
  }
  return out;
}

/** Симулировать стратегию (правило) по свечам. Чистая. */
export function simulate(candles: readonly Candle[], signal: SignalFn, opts: SimOpts = {}): { stats: SimStats; list: SimTrade[] } {
  const atrPeriod = opts.atrPeriod ?? 14;
  const atrMult = opts.atrMultStop ?? 1.5;
  const rr = opts.rrTarget ?? 2;
  const maxHold = opts.maxHold ?? 24;
  const cost = opts.costPct ?? 0;
  const warmup = Math.max(opts.warmup ?? 60, atrPeriod + 2);
  const atrArr = atrSeries(candles, atrPeriod);
  const list: SimTrade[] = [];
  let i = warmup;
  while (i < candles.length - 1) {
    const dir = signal(candles, i);
    const a = atrArr[i];
    if (!dir || a == null || a <= 0) {
      i += 1;
      continue;
    }
    const entry = candles[i]!.c;
    const risk = atrMult * a;
    const stop = dir === "up" ? entry - risk : entry + risk;
    const target = dir === "up" ? entry + rr * risk : entry - rr * risk;
    const end = Math.min(i + maxHold, candles.length - 1);
    let exitI = end;
    let exit = candles[end]!.c;
    let outcome: "target" | "stop" | "time" = "time";
    for (let j = i + 1; j <= end; j++) {
      const c = candles[j]!;
      const hitStop = dir === "up" ? c.l <= stop : c.h >= stop;
      const hitTarget = dir === "up" ? c.h >= target : c.l <= target;
      if (hitStop) {
        exitI = j;
        exit = stop;
        outcome = "stop"; // консервативно: стоп раньше тейка в одной свече
        break;
      }
      if (hitTarget) {
        exitI = j;
        exit = target;
        outcome = "target";
        break;
      }
    }
    const gross = dir === "up" ? exit - entry : entry - exit;
    const rMultiple = gross / risk;
    const riskPct = (risk / entry) * 100;
    const netR = rMultiple - (riskPct > 0 ? cost / riskPct : 0);
    list.push({ i, dir, entry, stop, target, exitI, exit, rMultiple, netR, outcome });
    i = exitI + 1; // сделки не перекрываются
  }
  return { stats: statsOf(list), list };
}

/** Сводная статистика по списку сделок (чистая). */
export function statsOf(list: readonly SimTrade[]): SimStats {
  const net = list.map((t) => t.netR);
  const wins = net.filter((x) => x > 0);
  const winSum = wins.reduce((a, b) => a + b, 0);
  const lossSum = -net.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  let cum = 0;
  let peak = 0;
  let mdd = 0;
  for (const x of net) {
    cum += x;
    peak = Math.max(peak, cum);
    mdd = Math.min(mdd, cum - peak);
  }
  return {
    trades: list.length,
    wins: wins.length,
    winRate: list.length > 0 ? wins.length / list.length : 0,
    expectancyR: avg(list.map((t) => t.rMultiple)),
    netExpectancyR: avg(net),
    profitFactor: lossSum > 0 ? winSum / lossSum : winSum > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdownR: mdd,
  };
}
