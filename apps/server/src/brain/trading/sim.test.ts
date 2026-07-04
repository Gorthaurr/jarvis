import { describe, expect, it } from "vitest";
import type { Candle } from "./market.js";
import { type SignalFn, simulate, statsOf } from "./sim.js";

/** Свеча с заданным close и узким диапазоном ±0.5. */
const bar = (c: number): Candle => ({ t: 0, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 });
const alwaysUp: SignalFn = () => "up";

describe("sim — бэктест-движок (§трейдинг: поиск края)", () => {
  it("устойчивый рост + лонг → почти все ТЕЙК, все в плюс, винрейт 100%", () => {
    const candles = Array.from({ length: 120 }, (_, k) => bar(100 + k)); // +1/бар
    const { stats, list } = simulate(candles, alwaysUp, { atrPeriod: 5, atrMultStop: 1.5, rrTarget: 2, maxHold: 30, warmup: 10 });
    expect(list.length).toBeGreaterThan(2);
    expect(list.every((t) => t.rMultiple > 0)).toBe(true); // тренд вверх → лонг прибылен
    expect(stats.winRate).toBe(1);
    expect(stats.expectancyR).toBeGreaterThan(1); // ≈rr (последняя у края серии может выйти по времени)
    expect(list.filter((t) => t.outcome === "target").length).toBeGreaterThanOrEqual(list.length - 1);
  });

  it("устойчивое падение + лонг → почти все СТОП, все в минус, винрейт 0%", () => {
    const candles = Array.from({ length: 120 }, (_, k) => bar(100 - k)); // −1/бар
    const { stats, list } = simulate(candles, alwaysUp, { atrPeriod: 5, atrMultStop: 1.5, rrTarget: 2, maxHold: 30, warmup: 10 });
    expect(list.length).toBeGreaterThan(2);
    expect(list.every((t) => t.rMultiple < 0)).toBe(true); // лонг в падении — убыток
    expect(stats.winRate).toBe(0);
    expect(stats.expectancyR).toBeLessThan(0);
    expect(list.filter((t) => t.outcome === "stop").length).toBeGreaterThanOrEqual(list.length - 1);
  });

  it("net учитывает издержки (netExpectancyR < expectancyR при costPct>0)", () => {
    const candles = Array.from({ length: 120 }, (_, k) => bar(100 + k));
    const { stats } = simulate(candles, alwaysUp, { atrPeriod: 5, atrMultStop: 1.5, rrTarget: 2, maxHold: 30, warmup: 10, costPct: 0.5 });
    expect(stats.netExpectancyR).toBeLessThan(stats.expectancyR);
  });

  it("statsOf: профит-фактор и просадка по списку", () => {
    const mk = (netR: number) => ({ i: 0, dir: "up" as const, entry: 1, stop: 1, target: 1, exitI: 1, exit: 1, rMultiple: netR, netR, outcome: "time" as const });
    const s = statsOf([mk(2), mk(-1), mk(1), mk(-1)]); // wins 3, losses 2 → PF 1.5
    expect(s.profitFactor).toBeCloseTo((2 + 1) / (1 + 1), 6);
    expect(s.winRate).toBe(0.5);
    expect(s.maxDrawdownR).toBeLessThan(0);
  });
});
