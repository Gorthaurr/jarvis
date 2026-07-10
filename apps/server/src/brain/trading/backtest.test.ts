import { describe, expect, it } from "vitest";
import { conditionalBaseRate, multiFactorBaseRate } from "./backtest.js";

describe("backtest — исторические базовые ставки (§трейдинг, годы данных)", () => {
  it("мало истории → null (честно, не выдумываем статистику)", () => {
    expect(conditionalBaseRate([1, 2, 3, 4, 5], 1)).toBeNull();
  });

  it("на достаточной истории считает ставки + базу, значения в диапазоне", () => {
    // 250 синтетических закрытий с колебаниями + дрейфом
    const closes = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 4) * 8 + i * 0.05);
    const r = conditionalBaseRate(closes, 1);
    expect(r).not.toBeNull();
    expect(r!.bars).toBe(250);
    expect(r!.currentRsi).toBeGreaterThanOrEqual(0);
    expect(r!.currentRsi).toBeLessThanOrEqual(100);
    expect(r!.upRate).toBeGreaterThanOrEqual(0);
    expect(r!.upRate).toBeLessThanOrEqual(1);
    expect(r!.baselineUpRate).toBeGreaterThan(0);
    expect(r!.samples).toBeGreaterThan(0);
    expect(r!.bucket).toMatch(/RSI/);
  });

  it("растущий ряд: база роста высокая (восходящий дрейф)", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i); // строго вверх
    const r = conditionalBaseRate(closes, 1);
    expect(r).not.toBeNull();
    expect(r!.baselineUpRate).toBe(1); // каждый следующий бар выше
    expect(r!.trendUp).toBe(true); // строго растущий → цена выше SMA50
  });

  it("multiFactorBaseRate: связка RSI+тренд+MACD, диапазоны ок; мало истории → null", () => {
    expect(multiFactorBaseRate([1, 2, 3, 4, 5], 1)).toBeNull();
    const closes = Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.05);
    const r = multiFactorBaseRate(closes, 1);
    expect(r).not.toBeNull();
    expect(r!.setup).toMatch(/SMA50/);
    expect(r!.setup).toMatch(/MACD/);
    expect(r!.upRate).toBeGreaterThanOrEqual(0);
    expect(r!.upRate).toBeLessThanOrEqual(1);
    expect(r!.samples).toBeGreaterThanOrEqual(0);
  });
});
