import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_LIMITS, canAdd, clusterOf, positionSize } from "./risk.js";

const lim = DEFAULT_RISK_LIMITS; // риск 1%, макс позиция 20%, кластер 50%, 6 позиций, буфер 10%

describe("risk — размер позиции + диверсификация (§трейдинг исполнение)", () => {
  it("positionSize: от риска, с капом по макс позиции; без стопа → 0", () => {
    // баланс 10000, вход 100, стоп 90 (риск/ед 10): риск-деньги 100 → 10 ед (риск-лимит)
    expect(positionSize(10000, 100, 90, lim)).toBeCloseTo(10, 6);
    // стоп 99 (риск/ед 1): по риску 100 ед, но кап 20% = 2000/100 = 20 ед → 20
    expect(positionSize(10000, 100, 99, lim)).toBeCloseTo(20, 6);
    expect(positionSize(10000, 100, 100, lim)).toBe(0); // нет дистанции до стопа
    expect(positionSize(0, 100, 90, lim)).toBe(0);
  });

  it("canAdd: лимит на ОДИН инструмент (макс 20% баланса)", () => {
    expect(canAdd(10000, [], { symbol: "BTC", cluster: "crypto", notional: 2500 }, lim).ok).toBe(false);
    expect(canAdd(10000, [], { symbol: "BTC", cluster: "crypto", notional: 1500 }, lim).ok).toBe(true);
  });

  it("canAdd: лимит на КЛАСТЕР — крипта это одна ставка (не dilu 5 монетами)", () => {
    const cur = [
      { symbol: "BTC", cluster: "crypto", notional: 1500 },
      { symbol: "ETH", cluster: "crypto", notional: 1500 },
      { symbol: "SOL", cluster: "crypto", notional: 1500 },
    ];
    const r = canAdd(10000, cur, { symbol: "XRP", cluster: "crypto", notional: 1500 }, lim); // 6000 > 50%
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/кластер/);
  });

  it("canAdd: максимум одновременных позиций (новый символ блокируется, добавление к старой — нет)", () => {
    const lim2 = { ...lim, maxConcurrent: 2, maxClusterPct: 100, maxPositionPct: 100, cashBufferPct: 0 };
    const cur = [
      { symbol: "A", cluster: "x", notional: 100 },
      { symbol: "B", cluster: "x", notional: 100 },
    ];
    expect(canAdd(10000, cur, { symbol: "C", cluster: "x", notional: 100 }, lim2).ok).toBe(false);
    expect(canAdd(10000, cur, { symbol: "A", cluster: "x", notional: 100 }, lim2).ok).toBe(true);
  });

  it("canAdd: буфер кэша (не входим на 100%)", () => {
    const lim3 = { ...lim, maxPositionPct: 100, maxClusterPct: 100, cashBufferPct: 10 };
    expect(canAdd(10000, [{ symbol: "A", cluster: "x", notional: 8000 }], { symbol: "B", cluster: "x", notional: 1500 }, lim3).ok).toBe(false); // 9500 > 9000
  });

  it("clusterOf: крипта (вкл. фьючи) → crypto; MosBirzha/tinkoff → moex", () => {
    expect(clusterOf("crypto")).toBe("crypto");
    expect(clusterOf("crypto_fut")).toBe("crypto");
    expect(clusterOf("moex")).toBe("moex");
    expect(clusterOf("moex_fut")).toBe("moex");
    expect(clusterOf("tinkoff")).toBe("moex");
  });
});
