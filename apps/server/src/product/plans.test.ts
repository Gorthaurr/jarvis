/**
 * Планы против НАСТОЯЩЕЙ схемы (PGlite + миграции 0102): сиды на месте и читаются в тип без потерь,
 * upsert создаёт/правит, кривой план не попадает в БД.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductError } from "./db.js";
import { type Plan, getPlan, listPlans, upsertPlan } from "./plans.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";

describe("product/plans (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("сиды миграции 0102 читаются в тип: demo/trial/byo/basic/pro + три пакета, единицы целые", async () => {
    const plans = await listPlans();
    const ids = plans.map((p) => p.id);
    for (const id of ["demo", "trial", "byo", "basic", "pro", "pack50", "pack100", "pack300"]) expect(ids).toContain(id);
    const basic = await getPlan("basic");
    expect(basic).toMatchObject({ kind: "subscription", priceMinor: 150000, currency: "RUB", llmQuotaMicro: 8_000_000, byoKey: false, trialDays: 0 });
    expect(basic?.modelsAllowed).toEqual(["claude-sonnet-4-6", "claude-sonnet-5"]);
    const byo = await getPlan("byo");
    expect(byo?.byoKey).toBe(true);
    expect(byo?.modelsAllowed).toEqual([]);
    const trial = await getPlan("trial");
    expect(trial?.trialDays).toBe(7);
    const pack = await getPlan("pack50");
    expect(pack).toMatchObject({ kind: "pack", period: "once", packCreditsMicro: 4_370_000 });
    expect(Number.isInteger(pack?.packCreditsMicro)).toBe(true);
    expect(plans.map((p) => p.sortOrder)).toEqual([...plans.map((p) => p.sortOrder)].sort((a, b) => a - b));
  });

  it("getPlan неизвестного id → null (не исключение)", async () => {
    expect(await getPlan("no-such-plan")).toBeNull();
  });

  it("upsertPlan создаёт и правит; activeOnly скрывает выключенный", async () => {
    const draft: Plan = {
      id: "team", name: "Команда", kind: "subscription", priceMinor: 990000, currency: "rub", period: "month",
      llmQuotaMicro: 60_000_000, packCreditsMicro: 0, overageAllowed: true, overageMaxMicro: 5_000_000,
      modelsAllowed: ["claude-opus-5"], byoKey: false, trialDays: 3, features: { seats: 5 }, active: true, sortOrder: 60,
    };
    const created = await upsertPlan(draft);
    expect(created).toMatchObject({ id: "team", currency: "RUB", overageAllowed: true, overageMaxMicro: 5_000_000, trialDays: 3 });
    expect(created.features).toEqual({ seats: 5 });
    const updated = await upsertPlan({ ...draft, priceMinor: 1_190_000, active: false });
    expect(updated.priceMinor).toBe(1_190_000);
    expect(updated.active).toBe(false);
    expect((await listPlans({ activeOnly: true })).some((p) => p.id === "team")).toBe(false);
    expect((await listPlans()).some((p) => p.id === "team")).toBe(true);
  });

  it("невалидный план отвергается ДО записи (дробная цена, чужой kind, кривой id)", async () => {
    const base = (await getPlan("basic")) as Plan;
    await expect(upsertPlan({ ...base, id: "x1", priceMinor: 10.5 })).rejects.toBeInstanceOf(ProductError);
    await expect(upsertPlan({ ...base, id: "x2", kind: "gift" as Plan["kind"] })).rejects.toThrow(/kind/);
    await expect(upsertPlan({ ...base, id: "bad id!" })).rejects.toThrow(/id плана/);
    expect(await getPlan("x1")).toBeNull();
    expect(await getPlan("x2")).toBeNull();
  });
});
