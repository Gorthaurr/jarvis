/**
 * QuotaResolver против реальной схемы и НАСТОЯЩЕГО SpendGuards: byo → defaultCap, basic → квота плана,
 * кредиты добавляются к капу, warn-состояние durable, applyTo РЕАЛЬНО меняет SpendGuard.check
 * (реверт-проверка: убрать setLimitsFor из applyTo — тест «check после applyTo отказывает» падает).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpendGuards } from "../billing/index.js";
import { query } from "../db/pool.js";
import { grantCredits } from "./credits.js";
import { QuotaResolver } from "./quota.js";
import { startSubscription } from "./subscriptions.js";
import { q } from "./db.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";

const T0 = Date.UTC(2026, 8, 2, 12);
const U = (n: number): string => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const snap = (spent: number, cap: number) => ({ period: "2026-09", spent, cap, remaining: Math.max(0, cap - spent), killSwitch: false });

describe("product/quota (PGlite + SpendGuards)", () => {
  let tdb: ProductTestDb;
  const resolver = new QuotaResolver({ defaultCapUsd: 300, now: () => T0, rubPerUsd: 85 });
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("byo БЕЗ LLM-прокси → кап 0 + честная пометка (ключ проекта за чужой план не тратим); с прокси → runaway-кап", async () => {
    await q("update plans set active = true where id = 'byo'"); // 0105 выключает BYO в каталоге до LLM-прокси — тест включает явно
    const started = await startSubscription({ userId: U(1), planId: "byo", source: "admin", now: T0 });
    if (!started.ok) throw new Error(`byo не стартовал: ${started.reason}`);
    const l = await resolver.limitsFor(U(1));
    expect(l).toMatchObject({ planId: "byo", byoKey: true, capUsd: 0, quotaMicro: 0, modelsAllowed: null, status: "active", quotaSource: "plan" });
    expect(l.note).toMatch(/не поддерживается/);
    expect(l.periodEnd).toBe(new Date(T0 + 30 * 86_400_000).toISOString());
    const withProxy = new QuotaResolver({ defaultCapUsd: 300, byoSupported: true, now: () => T0, rubPerUsd: 85 });
    const p = await withProxy.limitsFor(U(1));
    expect(p).toMatchObject({ planId: "byo", byoKey: true, capUsd: 300 });
    expect(p.note).toBeUndefined();
  });

  it("basic → квота плана $8, allowlist моделей; кредиты пакета ДОБАВЛЯЮТСЯ к капу", async () => {
    await startSubscription({ userId: U(2), planId: "basic", source: "admin", now: T0 });
    const before = await resolver.limitsFor(U(2));
    expect(before).toMatchObject({ planId: "basic", quotaMicro: 8_000_000, creditsMicro: 0, capUsd: 8, byoKey: false, softPct: 80 });
    expect(before.modelsAllowed).toEqual(["claude-sonnet-4-6", "claude-sonnet-5"]);
    await grantCredits({ userId: U(2), source: "pack", planId: "pack50", amountMicro: 4_370_000 });
    const after = await resolver.limitsFor(U(2));
    expect(after.creditsMicro).toBe(4_370_000);
    expect(after.capUsd).toBeCloseTo(12.37, 6);
  });

  it("нет подписки и нет defaultPlanId → кап 0 (деградация); с defaultPlanId — план по умолчанию, status none", async () => {
    const none = await resolver.limitsFor(U(3));
    expect(none).toMatchObject({ planId: null, capUsd: 0, status: "none", quotaSource: "none", modelsAllowed: null });
    const withDefault = new QuotaResolver({ defaultPlanId: "demo", defaultCapUsd: 300, now: () => T0 });
    const d = await withDefault.limitsFor(U(3));
    expect(d).toMatchObject({ planId: "demo", capUsd: 3, status: "none", quotaSource: "default", periodEnd: null });
  });

  it("applyTo РЕАЛЬНО ограничивает SpendGuard.check и пишет источник квоты в usage_quota", async () => {
    await startSubscription({ userId: U(4), planId: "basic", source: "admin", now: T0 });
    const spend = new SpendGuards({ spendCap: 300 }, { now: () => T0 });
    expect(spend.forUser(U(4)).check("t", 9).allowed).toBe(true); // платформенный дефолт $300 пропускает
    const applied = await resolver.applyTo(spend, U(4));
    expect(applied.capUsd).toBe(8);
    const d = spend.forUser(U(4)).check("t", 9);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("spend_cap");
    expect(spend.forUser(U(4)).check("t", 7.5).allowed).toBe(true);
    expect(spend.forUser(U(4)).getLimits().spendCap).toBe(8);
    const row = await query<{ llm_quota_micro: unknown; quota_source: string }>("select llm_quota_micro, quota_source from usage_quota where user_id = $1 and period = '2026-09'", [U(4)]);
    expect(Number(row?.rows[0]?.llm_quota_micro)).toBe(8_000_000);
    expect(row?.rows[0]?.quota_source).toBe("plan");
    // Без подписки — кап 0: любой платный шаг отказан.
    const zero = new SpendGuards({ spendCap: 300 }, { now: () => T0 });
    await resolver.applyTo(zero, U(5));
    expect(zero.forUser(U(5)).check("t", 0.001).reason).toBe("spend_cap");
  });

  it("warn-состояние durable: markWarned ставит один раз, warnedState читает, usageInfoFor отражает", async () => {
    await startSubscription({ userId: U(6), planId: "basic", source: "admin", now: T0 });
    expect(await resolver.warnedState(U(6), "2026-09")).toMatchObject({ warned80At: null, warned100At: null, softPct: 80 });
    await resolver.markWarned(U(6), "2026-09", "80", T0);
    await resolver.markWarned(U(6), "2026-09", "80", T0 + 5000); // повтор не двигает первую отметку
    const w = await resolver.warnedState(U(6), "2026-09");
    expect(w.warned80At).toBe(T0);
    expect(w.warned100At).toBeNull();
    const info = await resolver.usageInfoFor(U(6), snap(2, 8), T0);
    expect(info).toMatchObject({ plan: "Базовый", planId: "basic", status: "active", currency: "USD", warn: "80", spent: 2, cap: 8 });
    // unit/note — чтобы голое число не читалось как обман («начислено 371» за 900 ₽), живой прогон 2026-09-02
    expect(info.credits).toEqual({ quota: 680, used: 170, remaining: 510, pct: 25, unit: "₽", note: "1 кредит ≈ 1 ₽ работы модели" });
    await resolver.markWarned(U(6), "2026-09", "100", T0 + 10_000);
    expect((await resolver.usageInfoFor(U(6), snap(2, 8), T0)).warn).toBe("100");
  });

  it("usageInfoFor: warn по факту spentPct без отметок; byo без кредитов; без плана — «Без тарифа»", async () => {
    await startSubscription({ userId: U(7), planId: "pro", source: "admin", now: T0 });
    expect((await resolver.usageInfoFor(U(7), snap(1, 25), T0)).warn).toBeNull();
    expect((await resolver.usageInfoFor(U(7), snap(21, 25), T0)).warn).toBe("80");
    expect((await resolver.usageInfoFor(U(7), snap(25, 25), T0)).warn).toBe("100");
    const byo = await resolver.usageInfoFor(U(1), snap(0, 300), T0);
    expect(byo.credits).toMatchObject({ quota: 0, used: 0, remaining: 0, pct: 0, unit: "₽" }); // BYO без прокси: работают только кредиты пакетов
    expect(byo.plan).toBe("Свой ключ");
    const none = await resolver.usageInfoFor(U(8), snap(0, 0), T0);
    expect(none.plan).toBe("Без тарифа");
    expect(none.status).toBe("none");
    expect(none.credits).toMatchObject({ quota: 0, used: 0, remaining: 0, pct: 0, unit: "₽" });
  });
});
