import { describe, expect, it } from "vitest";
import { CardDataError, type OrderPolicy, assertNoCardData, checkOrder } from "./order-guard.js";

const policy: OrderPolicy = { spendCap: 5000, silentThreshold: 1500, allowedVendors: ["Додо", "Тануки"] };
const order = (over: Partial<{ vendor: string; total: number }> = {}) => ({
  userId: "u",
  vendor: over.vendor ?? "Додо",
  items: [{ name: "пицца", qty: 1 }],
  total: over.total ?? 900,
});

describe("checkOrder (§14)", () => {
  it("обычное место в пороге → silent", () => {
    expect(checkOrder(order(), policy).status).toBe("silent");
  });
  it("сумма выше порога → needs_confirm", () => {
    expect(checkOrder(order({ total: 2000 }), policy).status).toBe("needs_confirm");
  });
  it("необычное заведение → needs_confirm", () => {
    expect(checkOrder(order({ vendor: "Незнакомая" }), policy).status).toBe("needs_confirm");
  });
  it("сумма выше spend cap → blocked_cap", () => {
    expect(checkOrder(order({ total: 9000 }), policy).status).toBe("blocked_cap");
  });
});

describe("assertNoCardData — красная линия карты (§0)", () => {
  it("чистый заказ проходит", () => {
    expect(() => assertNoCardData(order())).not.toThrow();
  });
  it("номер карты в значении → CardDataError", () => {
    expect(() => assertNoCardData({ note: "оплата 4111 1111 1111 1111" })).toThrow(CardDataError);
  });
  it("карточный ключ → CardDataError", () => {
    expect(() => assertNoCardData({ cardNumber: "x" })).toThrow(CardDataError);
    expect(() => assertNoCardData({ payment: { cvv: "123" } })).toThrow(CardDataError);
  });
});
