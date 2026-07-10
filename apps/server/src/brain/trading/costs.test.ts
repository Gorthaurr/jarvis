import { describe, expect, it } from "vitest";
import { roundTripCostPct } from "./costs.js";

describe("costs — круговая издержка сделки (§трейдинг, чистая прибыльность)", () => {
  it("дефолты по площадке", () => {
    expect(roundTripCostPct("moex")).toBeCloseTo(0.1, 6);
    expect(roundTripCostPct("tinkoff")).toBeCloseTo(0.1, 6);
    expect(roundTripCostPct("crypto")).toBeCloseTo(0.2, 6);
    expect(roundTripCostPct("crypto_fut")).toBeCloseTo(0.2, 6);
    expect(roundTripCostPct("moex_fut")).toBeCloseTo(0.04, 6);
  });

  it("env-override тарифа (напр. «Инвестор» 0.6% круг)", () => {
    process.env.JARVIS_COST_SHARES_PCT = "0.6";
    expect(roundTripCostPct("moex")).toBeCloseTo(0.6, 6);
    delete process.env.JARVIS_COST_SHARES_PCT;
    expect(roundTripCostPct("moex")).toBeCloseTo(0.1, 6); // вернулся к дефолту
  });
});
