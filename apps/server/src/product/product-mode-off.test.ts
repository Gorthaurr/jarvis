/**
 * КАНАРЕЙКА «МАСТЕР-ФЛАГ 0 = СЕГОДНЯШНЕЕ ПОВЕДЕНИЕ» (требование владельца 2026-09-02).
 * Проверяем поведением, а не грепом: (1) конфиг без флага → политика PRODUCT_OFF даже при включённых
 * подфлагах; (2) на голом Fastify с PRODUCT_OFF регистрация продуктовых роутов не добавляет НИ ОДНОГО пути
 * (/v1/meta → 404), а с включённым флагом — /v1/meta отвечает; (3) рантайм при флаге 0 инертен:
 * afterProvision/usageInfoFor/usageSinkFor/quotaExhaustedText → undefined, modelsSync = дефолты, и — главное —
 * к БД НИ ОДНОГО запроса (шпион на клиенте пула: контроль-ревью показало, что прежний ассерт «пороги не
 * вешаются» был декоративен — без БД deliverThreshold падал в .catch до вызова уведомителя).
 * Реверт-проверка: сними `if (!shouldRegisterProductRoutes(...)) return []` в routes/index.ts — тест 2 упадёт;
 * верни подфлагам независимость от мастера в policy.ts — упадёт тест 1; сними `if (!policy.quotas) return` в
 * attachThreshold — fireIfDue пойдёт в quota.warnedState и шпион насчитает запрос — упадёт тест 3.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { SpendGuards } from "../billing/index.js";
import { loadConfig } from "../config.js";
import { __setQueryClientForTests } from "../db/pool.js";
import { createProductRuntime } from "./gateway-hooks.js";
import { PRODUCT_OFF, resolveProductFlags } from "./policy.js";
import { registerProductRoutes } from "./routes/index.js";
import type { ProductRouteDeps } from "./routes/deps.js";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  __setQueryClientForTests(null);
});

function depsFor(policy: ProductRouteDeps["policy"]): ProductRouteDeps {
  const cfg = { ...loadConfig(), product: policy };
  const spend = new SpendGuards({ spendCap: 300 });
  return createProductRuntime(cfg, spend).routeDeps();
}

describe("мастер-флаг 0 = как сегодня", () => {
  it("loadConfig без JARVIS_PRODUCT_MODE → product = PRODUCT_OFF даже при включённых подфлагах", () => {
    delete process.env.JARVIS_PRODUCT_MODE;
    process.env.JARVIS_PRODUCT_AUTH = "1";
    process.env.JARVIS_PRODUCT_BILLING = "1";
    process.env.JARVIS_BILLING_PROVIDER = "fake";
    process.env.JARVIS_PRODUCT_EXPOSED = "1";
    const cfg = loadConfig();
    expect(cfg.product).toBe(PRODUCT_OFF);
    expect(cfg.product.enabled).toBe(false);
    expect(cfg.product.billingProvider).toBe("none");
    expect(cfg.product.exposed).toBe(false);
  });

  it("PRODUCT_OFF: ни одного продуктового роута; включённый флаг — /v1/meta отвечает", async () => {
    const off = Fastify({ logger: false });
    expect(registerProductRoutes(off, depsFor(PRODUCT_OFF))).toEqual([]);
    await off.ready();
    expect((await off.inject({ method: "GET", url: "/v1/meta" })).statusCode).toBe(404);
    expect((await off.inject({ method: "GET", url: "/v1/admin/reports" })).statusCode).toBe(404);
    expect((await off.inject({ method: "POST", url: "/dev/product/user" })).statusCode).toBe(404);
    await off.close();

    const on = Fastify({ logger: false });
    const groups = registerProductRoutes(on, depsFor(resolveProductFlags({ JARVIS_PRODUCT_MODE: "1" })));
    expect(groups).toContain("meta");
    expect(groups).toContain("auth");
    await on.ready();
    const meta = await on.inject({ method: "GET", url: "/v1/meta" });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().data.productMode).toBe(true);
    expect(meta.json().data.monetization).toBe("hybrid");
    await on.close();
  });

  it("рантайм при флаге 0 инертен: продуктовые точки отдают undefined, модели — дефолты, к БД — ни одного запроса", async () => {
    delete process.env.JARVIS_PRODUCT_MODE;
    const cfg = loadConfig();
    const spend = new SpendGuards({ spendCap: 300 });
    const rt = createProductRuntime(cfg, spend);
    let dbCalls = 0;
    __setQueryClientForTests({
      query: async () => {
        dbCalls += 1;
        throw new Error("флаг 0: продуктовый рантайм не должен ходить в БД");
      },
    } as never);
    const uid = "00000000-0000-0000-0000-000000000001";
    expect(rt.policy.enabled).toBe(false);
    expect(await rt.afterProvision(uid)).toBeUndefined();
    expect(await rt.usageInfoFor(uid)).toBeUndefined();
    expect(rt.usageSinkFor("u")).toBeUndefined();
    expect(rt.quotaExhaustedText()).toBeUndefined();
    expect(rt.modelsSync(uid)).toEqual(cfg.models);
    expect((await rt.modelsFor(uid)).models).toEqual(cfg.models);
    // Пороги не вешаются: уведомитель не должен вызываться, а fireIfDue не должен ходить в БД.
    rt.attachThreshold("u", "s1", () => {
      throw new Error("не должен вызываться при флаге 0");
    });
    rt.start();
    rt.stop();
    await new Promise((r) => setTimeout(r, 30)); // fire-and-forget внутри рантайма получает шанс выполниться
    expect(dbCalls).toBe(0);
    // Легаси-персист SpendGuard (usage_quota) при флаге 0 — прежнее поведение, к продуктовому рантайму не относится.
    spend.forUser("u").setLimits({ spendCap: 0.001 });
    spend.forUser("u").recordUsage("t", 10, 0.01);
  });
});
