/**
 * /v1/me, /v1/subscription, /v1/usage — аккаунт, устройства, экспорт/удаление, подписка и checkout,
 * расход. Всё под access-токеном (usage — и под device-токеном узла).
 */
import type { FastifyInstance } from "fastify";
import { emailHash, getAccount } from "../accounts.js";
import { exportAccount, requestDeletion } from "../accounts-lifecycle.js";
import { createLogger } from "@jarvis/shared";
import { verifyOtp } from "../auth.js";
import { createInvoice, listInvoices } from "../billing/invoices.js";
import { listDevices, revokeDevice } from "../devices.js";
import { ProductError } from "../db.js";
import { listPlans } from "../plans.js";
import { cancelAtPeriodEnd, effectivePlanFor } from "../subscriptions.js";
import { type ProductRouteDeps, type RouteReply, type RouteRequest, body, params, str } from "./deps.js";
import { authenticate, fail } from "./guards.js";

const log = createLogger("product:me");
/** Коды ProductError, чей текст безопасно отдать пользователю (остальные могут нести тело ответа провайдера). */
const SAFE_CHECKOUT_CODES: ReadonlySet<string> = new Set(["plan_not_found", "provider_none", "invalid_input"]);

export function registerMeRoutes(app: FastifyInstance, d: ProductRouteDeps): void {
  const authedOr401 = async (req: unknown, reply: RouteReply, kinds: Array<"access" | "device"> = ["access"]) => {
    const a = await authenticate(req as RouteRequest, kinds);
    if (!a) fail(reply, 401, "unauthorized", "нужен токен");
    return a;
  };

  app.get("/v1/me", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    const [acc, eff, usage] = await Promise.all([
      getAccount(a.userId),
      effectivePlanFor(a.userId, d.now()),
      d.usageInfo(a.userId),
    ]);
    return r.send({
      ok: true,
      data: {
        account: acc ? { id: acc.id, role: acc.role, status: acc.status, createdAt: acc.createdAt } : null,
        subscription: eff
          ? { planId: eff.plan.id, planName: eff.plan.name, status: eff.status, periodEnd: new Date(eff.subscription.currentPeriodEnd).toISOString(), byoKey: eff.plan.byoKey }
          : null,
        usage,
        monetization: d.policy.monetization,
        billingProvider: d.policy.billingProvider,
      },
    });
  });

  app.delete("/v1/me", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    const b = body(req as unknown as RouteRequest);
    const acc = await getAccount(a.userId);
    const email = str(b.email);
    // Удаление подтверждается кодом на СВОЙ адрес: сверяем хеш адреса с аккаунтом, затем код purpose=delete.
    if (!acc || !acc.emailHash || emailHash(email, d.pepper) !== acc.emailHash) return fail(r, 400, "email_mismatch", "адрес не совпадает с аккаунтом");
    const v = await verifyOtp({ email, code: str(b.code), pepper: d.pepper, purpose: "delete", now: new Date(d.now()), createIfMissing: false });
    if (!v.ok) return fail(r, 401, "invalid_code", `код подтверждения не подошёл (${v.reason})`);
    const res = await requestDeletion(a.userId, { now: new Date(d.now()) });
    if (!res.ok) return fail(r, 503, res.reason, "не удалось принять запрос на удаление");
    return r.send({ ok: true, data: { purgeAfter: res.purgeAfter.toISOString(), tokensRevoked: res.tokensRevoked } });
  });

  app.get("/v1/me/export", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    const data = await exportAccount(a.userId);
    if (!data) return fail(r, 404, "not_found", "аккаунт не найден");
    return r.send({ ok: true, data });
  });

  app.get("/v1/me/devices", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    return r.send({ ok: true, data: { devices: await listDevices(a.userId) } });
  });

  app.delete("/v1/me/devices/:id", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    const id = str(params(req as unknown as RouteRequest).id);
    const res = await revokeDevice(a.userId, id, { now: new Date(d.now()) });
    if (!res.device) return fail(r, 404, "not_found", "устройство не найдено");
    return r.send({ ok: true, data: res });
  });

  app.get("/v1/subscription", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    const [eff, invoices, plans] = await Promise.all([effectivePlanFor(a.userId, d.now()), listInvoices(a.userId, 20), listPlans({ activeOnly: true })]);
    return r.send({
      ok: true,
      data: {
        current: eff ? { planId: eff.plan.id, planName: eff.plan.name, status: eff.status, periodEnd: new Date(eff.subscription.currentPeriodEnd).toISOString(), cancelAtPeriodEnd: eff.subscription.cancelAtPeriodEnd } : null,
        invoices,
        plans: plans.map((p) => ({ id: p.id, name: p.name, kind: p.kind, priceMinor: p.priceMinor, currency: p.currency, period: p.period, llmQuotaMicro: p.llmQuotaMicro, packCreditsMicro: p.packCreditsMicro, byoKey: p.byoKey, trialDays: p.trialDays, modelsAllowed: p.modelsAllowed })),
        checkoutAvailable: d.policy.billing && d.policy.billingProvider !== "none",
      },
    });
  });

  app.post("/v1/subscription/checkout", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    if (!d.policy.billing || d.policy.billingProvider === "none") return fail(r, 409, "provider_none", "оплата выключена — план выдаёт администратор");
    const planId = str(body(req as unknown as RouteRequest).planId);
    if (!planId) return fail(r, 400, "bad_request", "нужен planId");
    try {
      const inv = await createInvoice({ userId: a.userId, planId, provider: d.provider, now: d.now(), returnUrl: d.returnUrl });
      return r.send({ ok: true, data: { invoiceId: inv.id, url: inv.checkoutUrl, amountMinor: inv.amountMinor, currency: inv.currency } });
    } catch (e) {
      // Наши честные коды (план не найден, провайдер none) — пользователю; текст чужой ошибки (БД/HTTP
      // провайдера) — только в лог (ревью 2026-09-02).
      log.warn("checkout не удался", { userId: a.userId, error: e instanceof Error ? e.message : String(e) });
      return fail(r, 400, "checkout_failed", e instanceof ProductError && SAFE_CHECKOUT_CODES.has(e.code) ? e.message : "не удалось создать счёт — попробуйте позже");
    }
  });

  app.post("/v1/subscription/cancel", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r);
    if (!a) return;
    const eff = await effectivePlanFor(a.userId, d.now());
    if (!eff) return fail(r, 404, "no_subscription", "живой подписки нет");
    const s = await cancelAtPeriodEnd(eff.subscription.id);
    return r.send({ ok: true, data: { cancelAtPeriodEnd: s?.cancelAtPeriodEnd ?? true, periodEnd: new Date(eff.subscription.currentPeriodEnd).toISOString() } });
  });

  app.get("/v1/usage", async (req, reply) => {
    const r = reply as unknown as RouteReply;
    const a = await authedOr401(req, r, ["access", "device"]);
    if (!a) return;
    return r.send({ ok: true, data: await d.usageInfo(a.userId) });
  });
}
