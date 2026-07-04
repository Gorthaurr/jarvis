import { describe, expect, it } from "vitest";
import { parseTinkoffCandles, parseTinkoffPortfolio, tinkoffNum } from "./tinkoff.js";

describe("Tinkoff — чистые парсеры (§трейдинг, реальный Тинькофф)", () => {
  it("tinkoffNum: Quotation {units,nano} → число; мусор → null", () => {
    expect(tinkoffNum({ units: "123", nano: 450000000 })).toBeCloseTo(123.45, 6);
    expect(tinkoffNum({ units: 250, nano: 0 })).toBe(250);
    expect(tinkoffNum({ units: "0", nano: 500000000 })).toBeCloseTo(0.5, 6);
    expect(tinkoffNum(null)).toBeNull();
    expect(tinkoffNum("х")).toBeNull();
  });

  it("parseTinkoffCandles: GetCandles → OHLCV", () => {
    const json = {
      candles: [
        { time: "2024-06-01T10:00:00Z", open: { units: "300", nano: 0 }, high: { units: "305", nano: 0 }, low: { units: "299", nano: 0 }, close: { units: "302", nano: 500000000 }, volume: "1500" },
      ],
    };
    const c = parseTinkoffCandles(json);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ o: 300, h: 305, l: 299, c: 302.5, v: 1500 });
    expect(Number.isFinite(c[0]!.t)).toBe(true);
    expect(parseTinkoffCandles({})).toEqual([]);
  });

  it("parseTinkoffPortfolio: позиции + P&L + суммарная стоимость", () => {
    const json = {
      totalAmountPortfolio: { units: "100000", nano: 0 },
      positions: [
        { figi: "BBG004730N88", instrumentType: "share", quantity: { units: "10", nano: 0 }, averagePositionPrice: { units: "250", nano: 0 }, currentPrice: { units: "300", nano: 0 } },
      ],
    };
    const p = parseTinkoffPortfolio(json);
    expect(p.totalRub).toBe(100000);
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0]).toMatchObject({ qty: 10, avgPrice: 250, currentPrice: 300 });
    expect(p.positions[0]!.pnlPct).toBeCloseTo(20, 6); // (300-250)/250
    expect(parseTinkoffPortfolio({}).positions).toEqual([]);
  });
});
