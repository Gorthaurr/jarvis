/**
 * Fake-провайдер: HMAC верен → событие; подделка/отсутствие подписи/битое тело → null.
 */
import { describe, expect, it } from "vitest";
import type { Plan } from "../../plans.js";
import { FakePaymentProvider } from "./fake.js";

const plan: Plan = {
  id: "basic", name: "Базовый", kind: "subscription", priceMinor: 150000, currency: "RUB", period: "month",
  llmQuotaMicro: 8_000_000, packCreditsMicro: 0, overageAllowed: false, overageMaxMicro: 0, modelsAllowed: [], byoKey: false,
  trialDays: 0, features: {}, active: true, sortOrder: 40,
};

describe("billing/providers/fake", () => {
  it("createCheckout → loopback-ссылка и ref; makeEvent подписывает тело, verifyWebhook его принимает", async () => {
    const p = new FakePaymentProvider("s3cret");
    const co = await p.createCheckout({ userId: "u", invoiceId: "inv", plan, returnUrl: "http://127.0.0.1/back" });
    expect(co.url).toBe(`http://127.0.0.1/fake-checkout/${co.providerRef}`);
    const ev = p.makeEvent({ providerRef: co.providerRef, kind: "paid" });
    const parsed = await p.verifyWebhook({ headers: ev.headers, rawBody: ev.rawBody });
    expect(parsed).toMatchObject({ kind: "paid", providerRef: co.providerRef, amountMinor: 150000, currency: "RUB" });
    expect(parsed?.eventId).toMatch(/^evt_/);
    // Заголовок в другом регистре (Fastify отдаёт lower-case) — тоже принимается.
    expect(await p.verifyWebhook({ headers: { "X-Fake-Signature": ev.headers["x-fake-signature"] }, rawBody: ev.rawBody })).not.toBeNull();
  });

  it("неверный секрет, подмена тела, отсутствие подписи, битый JSON, неизвестный kind → null", async () => {
    const p = new FakePaymentProvider("s3cret");
    const other = new FakePaymentProvider("other");
    const co = await p.createCheckout({ userId: "u", invoiceId: "inv", plan, returnUrl: "x" });
    const ev = p.makeEvent({ providerRef: co.providerRef, kind: "paid" });
    expect(await other.verifyWebhook({ headers: ev.headers, rawBody: ev.rawBody })).toBeNull();
    expect(await p.verifyWebhook({ headers: ev.headers, rawBody: ev.rawBody.replace("150000", "1") })).toBeNull();
    expect(await p.verifyWebhook({ headers: {}, rawBody: ev.rawBody })).toBeNull();
    expect(await p.verifyWebhook({ headers: { "x-fake-signature": p.sign("{not json") }, rawBody: "{not json" })).toBeNull();
    const bad = JSON.stringify({ eventId: "e", kind: "gift", providerRef: "r", providerPaymentId: "p", amountMinor: 1 });
    expect(await p.verifyWebhook({ headers: { "x-fake-signature": p.sign(bad) }, rawBody: bad })).toBeNull();
    const frac = JSON.stringify({ eventId: "e", kind: "paid", providerRef: "r", providerPaymentId: "p", amountMinor: 1.5 });
    expect(await p.verifyWebhook({ headers: { "x-fake-signature": p.sign(frac) }, rawBody: frac })).toBeNull();
  });

  it("makeEvent без известного чекаута требует явной суммы", () => {
    const p = new FakePaymentProvider();
    expect(() => p.makeEvent({ providerRef: "unknown", kind: "paid" })).toThrow(/amountMinor/);
    expect(p.makeEvent({ providerRef: "unknown", kind: "paid", amountMinor: 5 }).rawBody).toContain('"amountMinor":5');
  });
});
