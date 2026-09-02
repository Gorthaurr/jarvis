/**
 * /dev/product/* — стенд владельца для «пути пользователя» (только за JARVIS_DEV_HTTP=1 + loopback +
 * JARVIS_DEV_TOKEN, тем же preHandler, что у /dev/*): завести тестового пользователя с токеном узла,
 * получить код входа без почты (devEcho), докрутить расход до порога, подделать событие оплаты у
 * фейк-провайдера, выдать/перевести подписку, прогнать sweep. При мастер-флаге 0 не регистрируются.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createUser, emailHash, findUserByEmailHash, normalizeEmail } from "../accounts.js";
import { requestOtp } from "../auth.js";
import { FakePaymentProvider } from "../billing/providers/fake.js";
import { getInvoice } from "../billing/invoices.js";
import { processWebhook } from "../billing/webhooks.js";
import { registerDevice } from "../devices.js";
import { DEVICE_TOKEN_TTL_MS } from "../identity.js";
import { recordLedger } from "../ledger.js";
import { startSubscription, sweepLifecycle, transition } from "../subscriptions.js";
import { issueToken } from "../tokens.js";
import { type ProductRouteDeps, type RouteReply, type RouteRequest, body, str } from "./deps.js";
import { fail } from "./guards.js";
import { issueSessionPair } from "./auth.js";

export function registerDevProductRoutes(app: FastifyInstance, d: ProductRouteDeps): void {
  if (!d.dev) return;
  const pre = { preHandler: d.dev.preHandler as never };

  app.post("/dev/product/user", pre, async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const b = body(req as unknown as RouteRequest);
    const email = normalizeEmail(str(b.email) || `dev-${randomUUID().slice(0, 8)}@test.local`);
    const hash = emailHash(email, d.pepper);
    let userId = await findUserByEmailHash(hash);
    let created = false;
    if (!userId) {
      userId = await createUser({ emailHash: hash, emailEnc: d.encryptor?.(email) ?? null });
      created = true;
    }
    if (!userId) return fail(r, 503, "unavailable", "БД недоступна");
    const now = new Date(d.now());
    // Регистрируем устройство, как боевой путь: иначе выданный токен работает, но невидим в /v1/me/devices
    // и пользователю нечем его отозвать (живой прогон 2026-09-02).
    const installId = str(b.installId) || randomUUID();
    const deviceId = await registerDevice({ userId, installId, name: "dev-stand", now });
    const device = await issueToken({ userId, kind: "device", ttlMs: DEVICE_TOKEN_TTL_MS, ...(deviceId ? { deviceId } : {}), label: "dev-stand", now });
    const pair = await issueSessionPair(userId, now);
    const planId = str(b.planId);
    let subscription: unknown = null;
    if (planId) {
      const s = await startSubscription({ userId, planId, source: "demo", now: d.now() });
      subscription = s.ok ? { id: s.subscription.id, planId: s.subscription.planId, status: s.subscription.status } : { error: s.reason };
    }
    await d.quota.applyTo(d.spend, userId);
    return r.send({ ok: true, data: { userId, email, created, installId, deviceId, deviceToken: device?.raw, accessToken: pair?.accessToken, refreshToken: pair?.refreshToken, subscription } });
  });

  app.post("/dev/product/otp", pre, async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const b = body(req as unknown as RouteRequest);
    const res = await requestOtp({ email: str(b.email), pepper: d.pepper, limiter: d.limiter, sendMail: async () => "sent", purpose: str(b.purpose) === "delete" ? "delete" : "otp", now: new Date(d.now()), devEcho: true });
    return r.send({ ok: res.accepted, data: res });
  });

  app.post("/dev/product/usage", pre, async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const b = body(req as unknown as RouteRequest);
    const userId = str(b.userId);
    const addMicro = Math.round(Number(b.addMicro) || 0);
    if (!userId || addMicro <= 0) return fail(r, 400, "bad_request", "нужны userId и addMicro>0");
    await recordLedger({ userId, kind: "llm", model: "dev-stand", costMicro: addMicro, channel: "node", taskId: "dev-usage", ts: d.now() });
    d.spend.forUser(userId).recordUsage("dev-usage", 0, addMicro / 1e6);
    // Как на боевом пути: перерасход списывается с кредитов пакета, лимиты пересчитываются, свежий баланс
    // уезжает в открытое приложение. Иначе стенд владельца показывает поведение ХУЖЕ продакшена и вводит
    // в заблуждение того, кто на нём принимает работу (живой прогон 2026-09-02).
    await d.quota.settleCredits(userId);
    await d.quota.applyTo(d.spend, userId);
    await d.pushUsage?.(userId).catch(() => undefined);
    return r.send({ ok: true, data: { snapshot: d.spend.snapshot(userId), usage: await d.usageInfo(userId) } });
  });

  app.post("/dev/product/webhook", pre, async (req, reply) => {
    const r = reply as unknown as RouteReply;
    if (!(d.provider instanceof FakePaymentProvider)) return fail(r, 409, "provider_not_fake", "подделка события доступна только с JARVIS_BILLING_PROVIDER=fake");
    const b = body(req as unknown as RouteRequest);
    const kind = str(b.kind) || "paid";
    if (!["paid", "failed", "refunded", "canceled"].includes(kind)) return fail(r, 400, "bad_request", "kind: paid|failed|refunded|canceled");
    const made = d.provider.makeEvent({ providerRef: str(b.providerRef), kind: kind as "paid" | "failed" | "refunded" | "canceled", ...(Number.isFinite(Number(b.amountMinor)) ? { amountMinor: Number(b.amountMinor) } : {}) });
    const event = await d.provider.verifyWebhook({ headers: made.headers, rawBody: made.rawBody });
    if (!event) return fail(r, 500, "fake_sign_failed", "фейк-провайдер не подтвердил собственную подпись");
    const res = await processWebhook(d.provider, event, d.now());
    // Ровно то же, что делает боевой /v1/webhooks/:provider — иначе «оплата applied», а Джарвис продолжает
    // отвечать «кредиты исчерпаны» (живой прогон 2026-09-02).
    if (res.outcome === "applied" && res.invoiceId) {
      const inv = await getInvoice(res.invoiceId);
      if (inv) {
        await d.quota.applyTo(d.spend, inv.userId);
        await d.pushUsage?.(inv.userId).catch(() => undefined);
      }
    }
    return r.send({ ok: true, data: res });
  });

  app.post("/dev/product/subscription", pre, async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const b = body(req as unknown as RouteRequest);
    const userId = str(b.userId);
    const planId = str(b.planId);
    if (!userId || !planId) return fail(r, 400, "bad_request", "нужны userId и planId");
    const s = await startSubscription({ userId, planId, source: "demo", now: d.now(), periodDays: Number(b.periodDays) || 30 });
    if (!s.ok) return fail(r, 409, s.reason, `подписка не создана: ${s.reason}`);
    const status = str(b.status);
    const sub = status && status !== s.subscription.status ? await transition(s.subscription.id, status as "trialing" | "active" | "past_due" | "canceled" | "expired", {}) : s.subscription;
    await d.quota.applyTo(d.spend, userId);
    return r.send({ ok: true, data: { subscription: sub } });
  });

  app.post("/dev/product/sweep", pre, async (_req, reply) => {
    const r = reply as unknown as RouteReply;
    return r.send({ ok: true, data: { transitions: await sweepLifecycle(d.now()) } });
  });
}
