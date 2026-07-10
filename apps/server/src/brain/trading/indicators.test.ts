import { describe, expect, it } from "vitest";
import { atr, ema, emaSeries, macd, macdHistSeries, rsi, rsiSeries, sma, smaSeries } from "./indicators.js";

describe("indicators — чистая математика TA (§трейдинг)", () => {
  it("SMA: среднее последних period; недостаточно → null", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4); // (3+4+5)/3
    expect(sma([1, 2], 3)).toBeNull();
    expect(sma([], 1)).toBeNull();
  });

  it("EMA: сид = SMA первых period, далее рекуррентно (k=2/(p+1))", () => {
    // [1..6], period 3: сид sma([1,2,3])=2; →3→4→5 (k=0.5)
    expect(emaSeries([1, 2, 3, 4, 5, 6], 3)).toEqual([2, 3, 4, 5]);
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toBe(5);
    expect(ema([1, 2], 3)).toBeNull();
  });

  it("RSI: только рост → 100; только падение → 0; реалистичный ряд → (0,100)", () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14)).toBe(100);
    expect(rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14)).toBe(0);
    const r = rsi([10, 11, 10.5, 11.5, 12, 11.8, 12.5, 13, 12.7, 13.2, 13, 13.5, 14, 13.8, 14.2], 14);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0);
    expect(r!).toBeLessThan(100);
    expect(rsi([1, 2, 3], 14)).toBeNull(); // мало данных
  });

  it("rsiSeries: длина = вход, первые period — null, последнее = rsi()", () => {
    const v = [10, 11, 10.5, 11.5, 12, 11.8, 12.5, 13, 12.7, 13.2, 13, 13.5, 14, 13.8, 14.2, 14.5];
    const s = rsiSeries(v, 14);
    expect(s.length).toBe(v.length);
    expect(s[13]).toBeNull(); // индексы < period(14) → null
    expect(s[14]).not.toBeNull();
    expect(s[s.length - 1]).toBeCloseTo(rsi(v, 14)!, 6); // согласовано с rsi()
  });

  it("smaSeries: окно, первые period−1 — null, последнее = sma()", () => {
    const v = [1, 2, 3, 4, 5, 6];
    const s = smaSeries(v, 3);
    expect(s.length).toBe(6);
    expect(s[1]).toBeNull();
    expect(s[2]).toBe(2); // (1+2+3)/3
    expect(s[5]).toBe(5); // (4+5+6)/3
    expect(s[s.length - 1]).toBeCloseTo(sma(v, 3)!, 6);
  });

  it("macdHistSeries: длина = вход, последнее = macd().histogram", () => {
    const v = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const h = macdHistSeries(v);
    expect(h.length).toBe(50);
    expect(h[h.length - 1]).toBeCloseTo(macd(v)!.histogram, 6);
  });

  it("MACD: постоянный ряд → 0/0/0; мало данных → null", () => {
    const flat = Array.from({ length: 40 }, () => 100);
    const m = macd(flat);
    expect(m).not.toBeNull();
    expect(m!.macd).toBeCloseTo(0, 6);
    expect(m!.signal).toBeCloseTo(0, 6);
    expect(m!.histogram).toBeCloseTo(0, 6);
    expect(macd([1, 2, 3])).toBeNull();
  });

  it("ATR: эталонный мелкий кейс (период 2) → 2; мало данных → null", () => {
    const closes = [10, 11, 12, 13];
    const highs = [10, 12, 13, 14];
    const lows = [9, 10, 11, 12];
    expect(atr(highs, lows, closes, 2)).toBe(2);
    expect(atr([1, 2], [0, 1], [1, 2], 14)).toBeNull();
    expect(atr([1, 2, 3], [0, 1], [1, 2, 3], 2)).toBeNull(); // несовпадение длин
  });
});
