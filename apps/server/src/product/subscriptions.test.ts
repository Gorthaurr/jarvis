/**
 * Подписки против реальной схемы: одна живая, триал один раз, платный план без оплаты не стартует,
 * продление считает период честно, sweep переводит статусы по датам, effectivePlanFor видит только живую.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../db/pool.js";
import { DAY_MS } from "./db.js";
import {
  cancelAtPeriodEnd, effectivePlanFor, getLiveSubscription, lifecycleTarget, renewSubscription, startSubscription, sweepLifecycle, transition,
} from "./subscriptions.js";
import { fetchSubscription } from "./subscription-rows.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";

const T0 = Date.UTC(2026, 8, 2, 12, 0, 0);
const U = (n: number): string => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("product/subscriptions (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("триал: status trialing, trial_end = now + trialDays, users.trial_used_at проставлен; второй триал → trial_used", async () => {
    const r = await startSubscription({ userId: U(1), planId: "trial", source: "signup", now: T0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trial).toBe(true);
    expect(r.subscription.status).toBe("trialing");
    expect(r.subscription.trialEnd).toBe(T0 + 7 * DAY_MS);
    expect(r.subscription.currentPeriodEnd).toBe(T0 + 7 * DAY_MS);
    const used = await query<{ trial_used_at: Date | null }>("select trial_used_at from users where id = $1", [U(1)]);
    expect(used?.rows[0]?.trial_used_at).not.toBeNull();
    // Живую снимаем и просим триал снова — отказ по факту использованного триала, а не «already_live».
    await transition(r.subscription.id, "canceled");
    const again = await startSubscription({ userId: U(1), planId: "trial", source: "signup", now: T0 + DAY_MS });
    expect(again).toEqual({ ok: false, reason: "trial_used" });
  });

  it("одна живая: второй старт → already_live с текущей подпиской", async () => {
    const a = await startSubscription({ userId: U(2), planId: "demo", source: "admin", now: T0 });
    expect(a.ok).toBe(true);
    const b = await startSubscription({ userId: U(2), planId: "basic", source: "admin", now: T0 });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.reason).toBe("already_live");
      expect(b.subscription?.planId).toBe("demo");
    }
  });

  it("платный план без триала и без оплаты (signup) НЕ стартует; admin/payment — стартует active на periodDays", async () => {
    expect(await startSubscription({ userId: U(3), planId: "basic", source: "signup", now: T0 })).toEqual({ ok: false, reason: "payment_required" });
    expect(await getLiveSubscription(U(3))).toBeNull();
    const r = await startSubscription({ userId: U(3), planId: "basic", source: "payment", provider: "fake", now: T0, periodDays: 30 });
    expect(r.ok && r.subscription.status === "active" && r.subscription.currentPeriodEnd === T0 + 30 * DAY_MS).toBe(true);
    expect(await startSubscription({ userId: U(4), planId: "pack50", source: "admin", now: T0 })).toEqual({ ok: false, reason: "not_subscription" });
    expect(await startSubscription({ userId: U(4), planId: "nope", source: "admin", now: T0 })).toEqual({ ok: false, reason: "plan_not_found" });
  });

  it("renew: ранняя оплата продлевает ОТ КОНЦА периода, просроченная — от момента оплаты; grace/cancel снимаются", async () => {
    const r = await startSubscription({ userId: U(5), planId: "basic", source: "admin", now: T0 });
    if (!r.ok) throw new Error("start failed");
    await cancelAtPeriodEnd(r.subscription.id);
    const early = await renewSubscription(r.subscription.id, T0 + 10 * DAY_MS, 30);
    expect(early?.currentPeriodStart).toBe(T0 + 30 * DAY_MS);
    expect(early?.currentPeriodEnd).toBe(T0 + 60 * DAY_MS);
    expect(early?.cancelAtPeriodEnd).toBe(false);
    await transition(r.subscription.id, "past_due", { graceUntil: T0 + 67 * DAY_MS });
    const late = await renewSubscription(r.subscription.id, T0 + 65 * DAY_MS, 30);
    expect(late?.status).toBe("active");
    expect(late?.currentPeriodStart).toBe(T0 + 65 * DAY_MS);
    expect(late?.graceUntil).toBeNull();
    expect(await renewSubscription("00000000-0000-4000-8000-000000000000", T0)).toBeNull();
  });

  it("lifecycleTarget: чистые переходы по датам", () => {
    const base = { id: "s", userId: "u", planId: "basic", currentPeriodStart: 0, cancelAtPeriodEnd: false, graceUntil: null, provider: "none", providerCustomerId: null, providerSubscriptionId: null, source: "admin" as const, createdAt: 0, updatedAt: 0 };
    expect(lifecycleTarget({ ...base, status: "trialing", trialEnd: T0 - 1, currentPeriodEnd: T0 - 1 }, T0, 7)?.to).toBe("expired");
    expect(lifecycleTarget({ ...base, status: "trialing", trialEnd: T0 + 1, currentPeriodEnd: T0 + 1 }, T0, 7)).toBeNull();
    expect(lifecycleTarget({ ...base, status: "past_due", trialEnd: null, currentPeriodEnd: 0, graceUntil: T0 - 1 }, T0, 7)?.to).toBe("expired");
    expect(lifecycleTarget({ ...base, status: "past_due", trialEnd: null, currentPeriodEnd: 0, graceUntil: T0 + 1 }, T0, 7)).toBeNull();
    expect(lifecycleTarget({ ...base, status: "active", trialEnd: null, currentPeriodEnd: T0 - 1, cancelAtPeriodEnd: true }, T0, 7)?.to).toBe("canceled");
    expect(lifecycleTarget({ ...base, status: "active", trialEnd: null, currentPeriodEnd: T0 - 1 }, T0, 7)).toEqual({ to: "past_due", patch: { graceUntil: T0 + 7 * DAY_MS } });
  });

  it("sweepLifecycle: trialing → expired (без grace); active+cancel → canceled; active → past_due; шаг за проход", async () => {
    const tr = await startSubscription({ userId: U(6), planId: "trial", source: "signup", now: T0 });
    const ac = await startSubscription({ userId: U(7), planId: "basic", source: "admin", now: T0 });
    const cn = await startSubscription({ userId: U(8), planId: "basic", source: "admin", now: T0 });
    if (!tr.ok || !ac.ok || !cn.ok) throw new Error("start failed");
    await cancelAtPeriodEnd(cn.subscription.id);
    const ids = new Set([tr.subscription.id, ac.subscription.id, cn.subscription.id]);
    const mine = (list: Awaited<ReturnType<typeof sweepLifecycle>>) => list.filter((t) => ids.has(t.subscriptionId)).map((t) => [t.subscriptionId, t.from, t.to]);

    expect(mine(await sweepLifecycle(T0 + 6 * DAY_MS))).toEqual([]); // рано всем
    const day8 = mine(await sweepLifecycle(T0 + 8 * DAY_MS));
    expect(day8).toEqual([[tr.subscription.id, "trialing", "expired"]]); // триал не оплачивали — grace ему не положен
    expect((await fetchSubscription(tr.subscription.id))?.status).toBe("expired");
    expect(mine(await sweepLifecycle(T0 + 8 * DAY_MS))).toEqual([]); // повтор — идемпотентен
    expect(mine(await sweepLifecycle(T0 + 16 * DAY_MS))).toEqual([]);
    const day31 = mine(await sweepLifecycle(T0 + 31 * DAY_MS));
    expect(day31).toEqual(expect.arrayContaining([[ac.subscription.id, "active", "past_due"], [cn.subscription.id, "active", "canceled"]]));
    expect(day31).toHaveLength(2);
    expect(await getLiveSubscription(U(6))).toBeNull(); // expired — не живая
    expect(await getLiveSubscription(U(8))).toBeNull();
    expect((await getLiveSubscription(U(7)))?.status).toBe("past_due");
  });

  it("sweep не перетирает параллельный переход: ожидаемый статус изменился → переход не применяется", async () => {
    const r = await startSubscription({ userId: U(9), planId: "basic", source: "admin", now: T0 });
    if (!r.ok) throw new Error("start failed");
    // Имитируем «оплата пришла между чтением и записью»: renew уводит подписку вперёд, sweep со старым now её не трогает.
    await renewSubscription(r.subscription.id, T0 + 40 * DAY_MS);
    const t = (await sweepLifecycle(T0 + 31 * DAY_MS)).filter((x) => x.subscriptionId === r.subscription.id);
    expect(t).toEqual([]);
    expect((await fetchSubscription(r.subscription.id))?.status).toBe("active");
  });

  it("effectivePlanFor: живая → план+подписка+статус; после отмены → null", async () => {
    const r = await startSubscription({ userId: U(10), planId: "pro", source: "demo", now: T0 });
    if (!r.ok) throw new Error("start failed");
    const eff = await effectivePlanFor(U(10), T0);
    expect(eff?.plan.id).toBe("pro");
    expect(eff?.status).toBe("active");
    expect(eff?.subscription.id).toBe(r.subscription.id);
    await transition(r.subscription.id, "canceled");
    expect(await effectivePlanFor(U(10), T0)).toBeNull();
  });
});
