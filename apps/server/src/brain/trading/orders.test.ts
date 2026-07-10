import { describe, expect, it } from "vitest";
import { applyFill, notional } from "./orders.js";

describe("orders — позиция и PnL (§трейдинг слой 2, основа исполнения)", () => {
  it("notional = |qty|·цена", () => {
    expect(notional(10, 100)).toBe(1000);
    expect(notional(-5, 200)).toBe(1000);
  });

  it("applyFill: открытие → усреднение → частичное/полное закрытие → переворот", () => {
    // открытие лонга 10 @100
    let r = applyFill(undefined, "X", "crypto", "buy", 10, 100);
    expect(r.position.qty).toBe(10);
    expect(r.position.avgPrice).toBe(100);
    expect(r.realizedPnl).toBe(0);

    // докупка 10 @120 → средняя 110
    r = applyFill(r.position, "X", "crypto", "buy", 10, 120);
    expect(r.position.qty).toBe(20);
    expect(r.position.avgPrice).toBe(110);

    // продажа 5 @130 → realized 5·(130−110)=100, средняя входа не меняется
    r = applyFill(r.position, "X", "crypto", "sell", 5, 130);
    expect(r.position.qty).toBe(15);
    expect(r.realizedPnl).toBe(100);
    expect(r.position.avgPrice).toBe(110);

    // закрытие всех 15 @90 → realized 15·(90−110)=−300, позиция в ноль
    r = applyFill(r.position, "X", "crypto", "sell", 15, 90);
    expect(r.position.qty).toBe(0);
    expect(r.realizedPnl).toBe(-300);
    expect(r.position.avgPrice).toBe(0);
  });

  it("applyFill: переворот лонг→шорт (продал больше, чем было)", () => {
    const long5 = { symbol: "X", market: "crypto" as const, qty: 5, avgPrice: 100 };
    const r = applyFill(long5, "X", "crypto", "sell", 8, 110);
    expect(r.realizedPnl).toBe(50); // закрыл 5 лонга: 5·(110−100)
    expect(r.position.qty).toBe(-3); // остаток открыл в шорт
    expect(r.position.avgPrice).toBe(110); // по цене переворота
  });
});
