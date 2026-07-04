/**
 * СВЕЧНЫЕ ПАТТЕРНЫ (§трейдинг: price action, не только индикаторы).
 *
 * Распознаём ключевые свечные сигналы на ПОСЛЕДНЕЙ свече (± предыдущие): поглощения, молот, падающая
 * звезда, доджи. Чистые функции на OHLC → детерминированы, тестируются без сети. Это сигналы РАЗВОРОТА/
 * нерешительности — ДАННЫЕ для рассуждения, не гарантия (паттерн силён только в контексте тренда/уровня).
 */
import type { Candle } from "./market.js";

export type Bias = "bull" | "bear" | "neutral";

export interface CandleSignal {
  name: string;
  bias: Bias;
}

const body = (c: Candle): number => Math.abs(c.c - c.o);
const range = (c: Candle): number => c.h - c.l;
const upperWick = (c: Candle): number => c.h - Math.max(c.o, c.c);
const lowerWick = (c: Candle): number => Math.min(c.o, c.c) - c.l;
const isBull = (c: Candle): boolean => c.c > c.o;
const isBear = (c: Candle): boolean => c.c < c.o;

/** Найти свечные паттерны на последней свече (с учётом предыдущей). Пусто — ничего значимого. */
export function detectCandlePatterns(candles: readonly Candle[]): CandleSignal[] {
  const n = candles.length;
  if (n < 2) return [];
  const c0 = candles[n - 1]!;
  const c1 = candles[n - 2]!;
  const out: CandleSignal[] = [];
  const r0 = range(c0) || 1e-9;
  const b0 = body(c0);

  // Доджи — тело крошечное относительно диапазона (нерешительность/возможный разворот).
  if (b0 <= 0.1 * r0) out.push({ name: "доджи (нерешительность)", bias: "neutral" });

  // Молот — маленькое тело сверху, длинная нижняя тень (отказ от низов → бычий разворот).
  if (b0 <= 0.4 * r0 && lowerWick(c0) >= 2 * b0 && upperWick(c0) <= b0) {
    out.push({ name: "молот (бычий разворот)", bias: "bull" });
  }
  // Падающая звезда — маленькое тело снизу, длинная верхняя тень (отказ от верхов → медвежий разворот).
  if (b0 <= 0.4 * r0 && upperWick(c0) >= 2 * b0 && lowerWick(c0) <= b0) {
    out.push({ name: "падающая звезда (медвежий разворот)", bias: "bear" });
  }

  // Бычье поглощение — медвежья свеча, затем бычья с телом, перекрывающим предыдущее.
  if (isBear(c1) && isBull(c0) && c0.o <= c1.c && c0.c >= c1.o && body(c0) > body(c1)) {
    out.push({ name: "бычье поглощение", bias: "bull" });
  }
  // Медвежье поглощение — бычья свеча, затем медвежья, перекрывающая её.
  if (isBull(c1) && isBear(c0) && c0.o >= c1.c && c0.c <= c1.o && body(c0) > body(c1)) {
    out.push({ name: "медвежье поглощение", bias: "bear" });
  }

  return out;
}

/** Суммарный уклон паттернов: перевес бычьих/медвежьих (для сводки/решения). */
export function patternBias(signals: readonly CandleSignal[]): Bias {
  const bull = signals.filter((s) => s.bias === "bull").length;
  const bear = signals.filter((s) => s.bias === "bear").length;
  if (bull > bear) return "bull";
  if (bear > bull) return "bear";
  return "neutral";
}
