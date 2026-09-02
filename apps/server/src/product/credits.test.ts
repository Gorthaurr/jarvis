/**
 * Кредиты против реальной схемы: FIFO-списание, истечение, недостача, отрицательный грант возврата.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeCredits, creditBalanceMicro, grantCredits, listGrants } from "./credits.js";
import { DAY_MS, ProductError } from "./db.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";

const T0 = Date.UTC(2026, 8, 2, 12);
const U = (n: number): string => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("product/credits (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("грант → баланс; истёкший грант в баланс не входит", async () => {
    await grantCredits({ userId: U(1), source: "pack", planId: "pack50", amountMicro: 4_370_000 });
    await grantCredits({ userId: U(1), source: "admin", amountMicro: 1_000_000, expiresAt: T0 - 1, note: "просрочен" });
    expect(await creditBalanceMicro(U(1), T0)).toBe(4_370_000);
    expect(await creditBalanceMicro(U(1), T0 - DAY_MS)).toBe(5_370_000); // до истечения он считался
    expect(await creditBalanceMicro(U(99), T0)).toBe(0);
  });

  it("consume: FIFO по дате выдачи, остаток по грантам, недостача честная", async () => {
    const g1 = await grantCredits({ userId: U(2), source: "trial", amountMicro: 300 });
    const g2 = await grantCredits({ userId: U(2), source: "pack", amountMicro: 500 });
    expect(await consumeCredits(U(2), 400, T0)).toEqual({ consumed: 400, shortfall: 0 });
    const after = await listGrants(U(2));
    expect(after.find((g) => g.id === g1.id)?.remainingMicro).toBe(0); // первый выработан целиком
    expect(after.find((g) => g.id === g2.id)?.remainingMicro).toBe(400);
    expect(await consumeCredits(U(2), 1000, T0)).toEqual({ consumed: 400, shortfall: 600 });
    expect(await creditBalanceMicro(U(2), T0)).toBe(0);
    expect(await consumeCredits(U(2), 0, T0)).toEqual({ consumed: 0, shortfall: 0 });
  });

  it("истёкший грант не списывается, даже если остаток есть", async () => {
    await grantCredits({ userId: U(3), source: "admin", amountMicro: 1000, expiresAt: T0 - 1 });
    expect(await consumeCredits(U(3), 100, T0)).toEqual({ consumed: 0, shortfall: 100 });
  });

  it("возврат — отрицательный грант: баланс честно уменьшается (в минус, если пакет частично потрачен)", async () => {
    await grantCredits({ userId: U(4), source: "pack", planId: "pack50", amountMicro: 4_370_000 });
    await consumeCredits(U(4), 1_000_000, T0);
    await grantCredits({ userId: U(4), source: "refund", planId: "pack50", amountMicro: -4_370_000 });
    expect(await creditBalanceMicro(U(4), T0)).toBe(-1_000_000);
    await expect(grantCredits({ userId: U(4), source: "pack", amountMicro: -5 })).rejects.toBeInstanceOf(ProductError);
    await expect(grantCredits({ userId: U(4), source: "pack", amountMicro: 0 })).rejects.toThrow(/ненулевое/);
    await expect(grantCredits({ userId: U(4), source: "pack", amountMicro: 1.5 })).rejects.toThrow(/целое/);
  });
});
