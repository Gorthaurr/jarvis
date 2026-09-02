/**
 * Регистрация HTTP-роутов продукта. ПРИ МАСТЕР-ФЛАГЕ 0 НЕ ВЫЗЫВАЕТСЯ ВОВСЕ (gateway проверяет
 * `config.product.enabled`) — ни одного нового пути в дереве роутов; это фиксирует канарейка
 * product-mode-off.test.ts. При 1: /v1/meta всегда; auth/me/subscription — при policy.auth;
 * webhooks — при billing и провайдере ≠ none; admin — всегда (гард внутри); dev — при deps.dev.
 */
import type { FastifyInstance } from "fastify";
import { listPlans } from "../plans.js";
import { registerAdminRoutes } from "./admin.js";
import { registerAuthRoutes } from "./auth.js";
import type { ProductRouteDeps } from "./deps.js";
import { registerMeRoutes } from "./me.js";
import { registerDevProductRoutes } from "./dev.js";
import { registerWebhookRoutes } from "./webhooks.js";

export type { ProductRouteDeps } from "./deps.js";

/** Чистое решение «регистрировать ли продуктовые роуты» — для канарейки и boot-лога. */
export function shouldRegisterProductRoutes(policy: { enabled: boolean }): boolean {
  return policy.enabled === true;
}

export function registerProductRoutes(app: FastifyInstance, d: ProductRouteDeps): string[] {
  if (!shouldRegisterProductRoutes(d.policy)) return [];
  const groups: string[] = ["meta"];
  app.get("/v1/meta", async () => {
    // Планы — из БД; без БД отдаём честное plansUnavailable вместо 500 (meta нужна клиенту ДО входа).
    let plans: Array<Record<string, unknown>> = [];
    let plansUnavailable = false;
    try {
      plans = (await listPlans({ activeOnly: true })).map((p) => ({ id: p.id, name: p.name, kind: p.kind, priceMinor: p.priceMinor, currency: p.currency, period: p.period, trialDays: p.trialDays, byoKey: p.byoKey }));
    } catch {
      plansUnavailable = true;
    }
    return {
      ok: true,
      data: {
        productMode: true,
        role: d.policy.role,
        authMethods: d.policy.auth ? ["email_otp"] : [],
        monetization: d.policy.monetization,
        billingProvider: d.provider.kind, // реальный (fake на открытом сервере принудительно none)
        checkoutAvailable: d.policy.billing && d.provider.kind !== "none",
        plans,
        ...(plansUnavailable ? { plansUnavailable: true } : {}),
      },
    };
  });
  if (d.policy.auth) {
    registerAuthRoutes(app, d);
    registerMeRoutes(app, d);
    groups.push("auth", "me");
  }
  if (d.policy.billing && d.policy.billingProvider !== "none") {
    registerWebhookRoutes(app, d);
    groups.push("webhooks");
  }
  registerAdminRoutes(app, d);
  groups.push("admin");
  if (d.dev) {
    registerDevProductRoutes(app, d);
    groups.push("dev");
  }
  return groups;
}
