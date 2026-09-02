/**
 * HTTP-каркас продукта ПОВЕДЕНИЕМ: настоящий Fastify (inject) + настоящий Postgres (PGlite) с базовыми и
 * продуктовыми миграциями. Сквозной путь пользователя: код входа → токены → /v1/me → /v1/usage →
 * refresh (одноразовый) → logout; админ: список, грант плана, отчёты; оплата: checkout у фейк-провайдера →
 * вебхук → кредиты применились к SpendGuard; дубль вебхука — no-op; неверная подпись — 400.
 * Реверт-проверки: убери revokeToken в /v1/auth/refresh — упадёт «повторный refresh → 401»; убери
 * applyTo в вебхуке — упадёт «кредиты применились к квоте».
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { SpendGuards } from "../../billing/index.js";
import { FakePaymentProvider } from "../billing/providers/fake.js";
import { resolveProductFlags } from "../policy.js";
import { QuotaResolver } from "../quota.js";
import { RateLimiter } from "../rate-limit.js";
import { openProductTestDb } from "../test-db.js";
import type { ProductRouteDeps } from "./deps.js";
import { registerProductRoutes } from "./index.js";

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const INSTALL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("продуктовые роуты (Fastify inject + PGlite)", () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;
  const mails: Array<{ email: string; code: string }> = [];
  const spend = new SpendGuards({ spendCap: 300 });
  const provider = new FakePaymentProvider("test-secret");
  let access = "";
  let refresh = "";
  let device = "";
  let userId = "";

  beforeAll(async () => {
    const h = await openProductTestDb();
    close = h.close;
    const policy = resolveProductFlags({ JARVIS_PRODUCT_MODE: "1", JARVIS_BILLING_PROVIDER: "fake" });
    const deps: ProductRouteDeps = {
      policy,
      spend,
      quota: new QuotaResolver({ defaultPlanId: "demo", defaultCapUsd: 300, now: () => NOW }),
      provider,
      limiter: new RateLimiter(),
      pepper: "pepper-test",
      sendMail: async (email, code) => {
        mails.push({ email, code });
        return "sent";
      },
      now: () => NOW,
      returnUrl: "http://127.0.0.1/return",
      dev: { preHandler: async () => undefined },
      signupPlanId: "trial",
      usageInfo: (id) => deps.quota.usageInfoFor(id, spend.snapshot(id), NOW),
    };
    app = Fastify({ logger: false });
    registerProductRoutes(app, deps);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it("/v1/meta: планы из сидов, checkout доступен (fake)", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/meta" });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    expect(d.checkoutAvailable).toBe(true);
    expect(d.plans.map((p: { id: string }) => p.id)).toContain("basic");
  });

  it("код входа: 202 + письмо; verify создаёт пользователя, выдаёт токены и стартует триал", async () => {
    const req = await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email: "Friend@Example.com" } });
    expect(req.statusCode).toBe(202);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.email).toBe("friend@example.com");
    const bad = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", payload: { email: "friend@example.com", code: "000000" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", payload: { email: "friend@example.com", code: mails[0]?.code, installId: INSTALL, deviceName: "ПК" } });
    expect(ok.statusCode).toBe(200);
    const d = ok.json().data;
    expect(d.user.created).toBe(true);
    expect(d.user.signupPlan).toBe("trial");
    expect(d.accessToken).toMatch(/^jat_/);
    expect(d.refreshToken).toMatch(/^jrt_/);
    expect(d.deviceToken).toMatch(/^jdt_/);
    access = d.accessToken;
    refresh = d.refreshToken;
    device = d.deviceToken;
    userId = d.user.id;
  });

  it("/v1/me и /v1/usage: аккаунт, подписка trialing, usage с кредитами; device-токен годится для usage", async () => {
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${access}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.subscription.status).toBe("trialing");
    expect(me.json().data.subscription.planId).toBe("trial");
    const usage = await app.inject({ method: "GET", url: "/v1/usage", headers: { authorization: `Bearer ${device}` } });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().data.planId).toBe("trial");
    expect(usage.json().data.currency).toBe("USD");
    const noAuth = await app.inject({ method: "GET", url: "/v1/me" });
    expect(noAuth.statusCode).toBe(401);
    const devices = await app.inject({ method: "GET", url: "/v1/me/devices", headers: { authorization: `Bearer ${access}` } });
    expect(devices.json().data.devices).toHaveLength(1);
  });

  it("refresh одноразовый: повтор старого → 401; logout отзывает access", async () => {
    const r1 = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: refresh } });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: refresh } });
    expect(r2.statusCode).toBe(401);
    const newAccess = r1.json().data.accessToken as string;
    const out = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${newAccess}` } });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${newAccess}` } });
    expect(after.statusCode).toBe(401);
  });

  it("админ с loopback (токен не задан): пользователи, грант плана basic, отчёты json и md", async () => {
    const users = await app.inject({ method: "GET", url: "/v1/admin/users" });
    expect(users.statusCode).toBe(200);
    expect(users.json().data.users.some((u: { id: string }) => u.id === userId)).toBe(true);
    const grant = await app.inject({ method: "POST", url: `/v1/admin/users/${userId}/grant`, payload: { planId: "basic" } });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().data.subscription.planId).toBe("basic");
    expect(spend.forUser(userId).getLimits().spendCap).toBeCloseTo(8, 6); // квота basic $8 применилась сразу
    const reports = await app.inject({ method: "GET", url: "/v1/admin/reports" });
    expect(reports.json().data.reports.map((r: { name: string }) => r.name)).toContain("usage");
    const json = await app.inject({ method: "GET", url: "/v1/admin/reports/subscriptions" });
    expect(json.json().data.kpi["живых подписок"]).toBe(1);
    const md = await app.inject({ method: "GET", url: "/v1/admin/reports/overview?format=md" });
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("# Сводка продукта");
  });

  it("оплата пакета у фейк-провайдера: checkout → вебхук applied → кредиты в квоте; дубль — no-op; подпись — 400", async () => {
    const co = await app.inject({ method: "POST", url: "/v1/subscription/checkout", headers: { authorization: `Bearer ${access}` }, payload: { planId: "pack100" } });
    expect(co.statusCode).toBe(200);
    const { url, amountMinor } = co.json().data;
    expect(url).toContain("fake-checkout");
    const providerRef = String(url).split("/").pop()!;
    const capBefore = spend.forUser(userId).getLimits().spendCap;
    const ev = provider.makeEvent({ providerRef, kind: "paid", amountMinor, eventId: "evt-1" });
    const wh = await app.inject({ method: "POST", url: "/v1/webhooks/fake", headers: { ...ev.headers, "content-type": "application/json" }, payload: ev.rawBody });
    expect(wh.statusCode).toBe(200);
    expect(wh.json().data.outcome).toBe("applied");
    expect(spend.forUser(userId).getLimits().spendCap).toBeCloseTo(capBefore + 8.74, 6); // пакет 100 задач = $8.74 кредитов
    const dup = await app.inject({ method: "POST", url: "/v1/webhooks/fake", headers: { ...ev.headers, "content-type": "application/json" }, payload: ev.rawBody });
    expect(dup.json().data.duplicate).toBe(true);
    const forged = await app.inject({ method: "POST", url: "/v1/webhooks/fake", headers: { "x-fake-signature": "deadbeef", "content-type": "application/json" }, payload: ev.rawBody });
    expect(forged.statusCode).toBe(400);
    const unknown = await app.inject({ method: "POST", url: "/v1/webhooks/yookassa", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(unknown.statusCode).toBe(404);
  });

  it("dev-стенд: тестовый пользователь с токенами и планом; OTP с devEcho; докрутка расхода", async () => {
    const u = await app.inject({ method: "POST", url: "/dev/product/user", payload: { email: "tester@test.local", planId: "demo" } });
    expect(u.statusCode).toBe(200);
    expect(u.json().data.deviceToken).toMatch(/^jdt_/);
    expect(u.json().data.subscription.planId).toBe("demo");
    const otp = await app.inject({ method: "POST", url: "/dev/product/otp", payload: { email: "tester@test.local" } });
    expect(otp.json().data.code).toMatch(/^\d{6}$/);
    const uid = u.json().data.userId as string;
    const usage = await app.inject({ method: "POST", url: "/dev/product/usage", payload: { userId: uid, addMicro: 2_500_000 } });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().data.usage.credits.used).toBeGreaterThan(0);
  });
});
