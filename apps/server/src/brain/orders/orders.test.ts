import { describe, expect, it, vi } from "vitest";
import { CardDataError, type OrderPolicy } from "./order-guard.js";
import { type OrderDeps, placeOrder } from "./orders.js";

const policy: OrderPolicy = { spendCap: 5000, silentThreshold: 1500, allowedVendors: ["Додо"] };

function deps(over: Partial<OrderDeps> = {}): { deps: OrderDeps; placed: string[] } {
  const placedKeys = new Set<string>();
  const placed: string[] = [];
  const d: OrderDeps = {
    requestConfirm: async () => ({ approved: true }),
    isAlreadyPlaced: (k) => placedKeys.has(k),
    markPlaced: (k) => {
      placedKeys.add(k);
    },
    place: async (req) => {
      placed.push(req.vendor);
      return { ok: true, orderId: "o1" };
    },
    ...over,
  };
  return { deps: d, placed };
}

const usual = { userId: "u", vendor: "Додо", items: [{ name: "пицца" }], total: 900 };

describe("placeOrder (§14, UC-5)", () => {
  it("обычное место в пороге → размещён без confirm", async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const { deps: d, placed } = deps({ requestConfirm: confirm });
    const r = await placeOrder(usual, policy, d);
    expect(r.status).toBe("placed");
    expect(confirm).not.toHaveBeenCalled(); // silent
    expect(placed).toEqual(["Додо"]);
  });

  it("выше порога → confirm обязателен", async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const { deps: d } = deps({ requestConfirm: confirm });
    await placeOrder({ ...usual, total: 3000 }, policy, d);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("выше spend cap → blocked, не размещаем", async () => {
    const { deps: d, placed } = deps();
    const r = await placeOrder({ ...usual, total: 9000 }, policy, d);
    expect(r.status).toBe("blocked");
    expect(placed).toHaveLength(0);
  });

  it("отклонение пользователем → denied", async () => {
    const { deps: d, placed } = deps({ requestConfirm: async () => ({ approved: false }) });
    const r = await placeOrder({ ...usual, total: 3000 }, policy, d);
    expect(r.status).toBe("denied");
    expect(placed).toHaveLength(0);
  });

  it("идемпотентность: повтор того же заказа → duplicate (нет дубля)", async () => {
    const { deps: d, placed } = deps();
    await placeOrder(usual, policy, d);
    const r2 = await placeOrder(usual, policy, d);
    expect(r2.status).toBe("duplicate");
    expect(placed).toHaveLength(1);
  });

  it("красная линия карты (§0): карточные данные в заказе → CardDataError, ничего не оформляется", async () => {
    const { deps: d, placed } = deps();
    await expect(
      placeOrder({ ...usual, items: [{ name: "пицца, карта 4111111111111111" }] }, policy, d),
    ).rejects.toThrow(CardDataError);
    expect(placed).toHaveLength(0);
  });
});
