/**
 * Вебхуки против реальной схемы с fake-провайдером: оплата выдаёт подписку/кредиты, дубль — no-op,
 * несовпадение суммы НЕ выдаёт подписку, возврат снимает, none-провайдер честно отказывает.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../../db/pool.js";
import { creditBalanceMicro, listGrants } from "../credits.js";
import { DAY_MS, ProductError } from "../db.js";
import { getLiveSubscription } from "../subscriptions.js";
import { type ProductTestDb, openProductTestDb } from "../test-db.js";
import { createInvoice, getInvoice, listInvoices } from "./invoices.js";
import { FakePaymentProvider } from "./providers/fake.js";
import { NonePaymentProvider } from "./providers/none.js";
import type { WebhookEvent } from "./provider.js";
import { processWebhook } from "./webhooks.js";

const T0 = Date.UTC(2026, 8, 2, 12);
const U = (n: number): string => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function paymentsCount(invoiceId: string): Promise<number> {
  const r = await query<{ n: number }>("select count(*)::int as n from payments where invoice_id = $1", [invoiceId]);
  return r?.rows[0]?.n ?? -1;
}

describe("billing/webhooks (PGlite + fake provider)", () => {
  let tdb: ProductTestDb;
  const fake = new FakePaymentProvider("test-secret");
  const event = async (providerRef: string, kind: WebhookEvent["kind"], over: { amountMinor?: number; eventId?: string } = {}): Promise<WebhookEvent> => {
    const e = fake.makeEvent({ providerRef, kind, ...over });
    const parsed = await fake.verifyWebhook({ headers: e.headers, rawBody: e.rawBody });
    if (!parsed) throw new Error("fake verify failed");
    return parsed;
  };

  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("createInvoice: pending + сумма из плана + ссылка провайдера; бесплатный/неизвестный план — ошибка", async () => {
    const inv = await createInvoice({ userId: U(1), planId: "basic", provider: fake, now: T0, returnUrl: "http://127.0.0.1/back" });
    expect(inv).toMatchObject({ status: "pending", amountMinor: 150000, currency: "RUB", provider: "fake", planId: "basic" });
    expect(inv.checkoutUrl).toBe(`http://127.0.0.1/fake-checkout/${inv.providerRef}`);
    expect((await listInvoices(U(1))).map((i) => i.id)).toContain(inv.id);
    await expect(createInvoice({ userId: U(1), planId: "demo", provider: fake, now: T0, returnUrl: "x" })).rejects.toThrow(/бесплатный/);
    await expect(createInvoice({ userId: U(1), planId: "zzz", provider: fake, now: T0, returnUrl: "x" })).rejects.toBeInstanceOf(ProductError);
  });

  it("paid → подписка active, инвойс paid с subscription_id, одна строка payments; ДУБЛЬ события — no-op", async () => {
    const inv = await createInvoice({ userId: U(2), planId: "basic", provider: fake, now: T0, returnUrl: "x" });
    const ev = await event(inv.providerRef!, "paid");
    const r1 = await processWebhook(fake, ev, T0);
    expect(r1.outcome).toBe("applied");
    const sub = await getLiveSubscription(U(2));
    expect(sub?.status).toBe("active");
    expect(sub?.planId).toBe("basic");
    expect(sub?.source).toBe("payment");
    expect(sub?.currentPeriodEnd).toBe(T0 + 30 * DAY_MS);
    const paid = await getInvoice(inv.id);
    expect(paid?.status).toBe("paid");
    expect(paid?.subscriptionId).toBe(sub?.id);
    expect(paid?.paidAt).toBe(T0);
    expect(await paymentsCount(inv.id)).toBe(1);
    // Тот же eventId ещё раз (повтор провайдера): duplicate, подписка не продлевается, платежей не прибавляется.
    const r2 = await processWebhook(fake, ev, T0 + DAY_MS);
    expect(r2).toMatchObject({ duplicate: true, outcome: "duplicate" });
    expect((await getLiveSubscription(U(2)))?.currentPeriodEnd).toBe(T0 + 30 * DAY_MS);
    expect(await paymentsCount(inv.id)).toBe(1);
    const we = await query<{ outcome: string; processed_at: Date | null }>("select outcome, processed_at from webhook_events where provider = 'fake' and event_id = $1", [ev.eventId]);
    expect(we?.rows[0]?.outcome).toBe("applied");
    expect(we?.rows[0]?.processed_at).not.toBeNull();
  });

  it("amount_mismatch: сумма события ≠ инвойса → подписка НЕ выдана, инвойс остаётся pending, платёж не записан", async () => {
    const inv = await createInvoice({ userId: U(3), planId: "pro", provider: fake, now: T0, returnUrl: "x" });
    const ev = await event(inv.providerRef!, "paid", { amountMinor: 100 });
    const r = await processWebhook(fake, ev, T0);
    expect(r.outcome).toBe("amount_mismatch");
    expect(await getLiveSubscription(U(3))).toBeNull();
    expect((await getInvoice(inv.id))?.status).toBe("pending");
    expect(await paymentsCount(inv.id)).toBe(0);
    // Верная сумма другим событием — проходит.
    const ok = await processWebhook(fake, await event(inv.providerRef!, "paid"), T0);
    expect(ok.outcome).toBe("applied");
    expect((await getLiveSubscription(U(3)))?.planId).toBe("pro");
  });

  it("повторная оплата того же плана → продление от конца периода; оплата другого плана → смена", async () => {
    const first = await createInvoice({ userId: U(4), planId: "basic", provider: fake, now: T0, returnUrl: "x" });
    await processWebhook(fake, await event(first.providerRef!, "paid"), T0);
    const second = await createInvoice({ userId: U(4), planId: "basic", provider: fake, now: T0 + 20 * DAY_MS, returnUrl: "x" });
    const r = await processWebhook(fake, await event(second.providerRef!, "paid"), T0 + 20 * DAY_MS);
    expect(r.outcome).toBe("applied");
    const sub = await getLiveSubscription(U(4));
    expect(sub?.currentPeriodEnd).toBe(T0 + 60 * DAY_MS);
    const upgrade = await createInvoice({ userId: U(4), planId: "pro", provider: fake, now: T0 + 25 * DAY_MS, returnUrl: "x" });
    const r2 = await processWebhook(fake, await event(upgrade.providerRef!, "paid"), T0 + 25 * DAY_MS);
    expect(r2.outcome).toBe("applied");
    const after = await getLiveSubscription(U(4));
    expect(after?.planId).toBe("pro");
    expect(after?.id).not.toBe(sub?.id);
    const old = await query<{ status: string }>("select status from subscriptions where id = $1", [sub!.id]);
    expect(old?.rows[0]?.status).toBe("canceled");
  });

  it("pack → кредиты; refund пакета → отрицательный грант, баланс 0; refund подписки → canceled", async () => {
    const pack = await createInvoice({ userId: U(5), planId: "pack50", provider: fake, now: T0, returnUrl: "x" });
    const r = await processWebhook(fake, await event(pack.providerRef!, "paid"), T0);
    expect(r.outcome).toBe("applied");
    expect(r.grantId).toBeDefined();
    expect(await creditBalanceMicro(U(5), T0)).toBe(4_370_000);
    const rf = await processWebhook(fake, await event(pack.providerRef!, "refunded"), T0 + DAY_MS);
    expect(rf.outcome).toBe("applied");
    expect(await creditBalanceMicro(U(5), T0 + DAY_MS)).toBe(0);
    expect((await listGrants(U(5))).map((g) => g.source).sort()).toEqual(["pack", "refund"]);
    expect((await getInvoice(pack.id))?.status).toBe("refunded");

    const sub = await createInvoice({ userId: U(6), planId: "basic", provider: fake, now: T0, returnUrl: "x" });
    await processWebhook(fake, await event(sub.providerRef!, "paid"), T0);
    expect((await getLiveSubscription(U(6)))?.status).toBe("active");
    const partial = await processWebhook(fake, await event(sub.providerRef!, "refunded", { amountMinor: 1000 }), T0 + DAY_MS);
    expect(partial.outcome).toBe("partial_refund");
    expect((await getLiveSubscription(U(6)))?.status).toBe("active"); // частичный возврат не снимает
    const full = await processWebhook(fake, await event(sub.providerRef!, "refunded"), T0 + 2 * DAY_MS);
    expect(full.outcome).toBe("applied");
    expect(await getLiveSubscription(U(6))).toBeNull();
    expect((await getInvoice(sub.id))?.status).toBe("refunded");
  });

  it("failed/canceled → инвойс failed/canceled без подписки; неизвестный ref → invoice_not_found; refund неоплаченного → ignored", async () => {
    const inv = await createInvoice({ userId: U(7), planId: "basic", provider: fake, now: T0, returnUrl: "x" });
    expect((await processWebhook(fake, await event(inv.providerRef!, "failed"), T0)).outcome).toBe("applied");
    expect((await getInvoice(inv.id))?.status).toBe("failed");
    expect(await getLiveSubscription(U(7))).toBeNull();
    expect((await processWebhook(fake, await event(inv.providerRef!, "canceled"), T0)).outcome).toBe("ignored");
    expect((await processWebhook(fake, await event(inv.providerRef!, "refunded"), T0)).outcome).toBe("ignored");
    const ghost = await event("fake_ghost", "paid", { amountMinor: 1 });
    expect((await processWebhook(fake, ghost, T0)).outcome).toBe("invoice_not_found");
  });

  it("none-провайдер: createInvoice бросает provider_none, инвойс не остаётся pending", async () => {
    const none = new NonePaymentProvider();
    await expect(createInvoice({ userId: U(8), planId: "basic", provider: none, now: T0, returnUrl: "x" })).rejects.toMatchObject({ code: "provider_none" });
    const rows = await listInvoices(U(8));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("canceled");
    expect(await none.verifyWebhook({ headers: {}, rawBody: "{}" })).toBeNull();
  });
});
