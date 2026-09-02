import { describe, expect, it } from "vitest";
import { PRODUCT_OFF, describeProductPolicy, resolveProductFlags } from "./policy.js";

describe("resolveProductFlags — мастер-переключатель", () => {
  it("мастер выключен → PRODUCT_OFF даже при включённых подфлагах (инвариант)", () => {
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { JARVIS_PRODUCT_MODE: "0" },
      { JARVIS_PRODUCT_MODE: "", JARVIS_PRODUCT_AUTH: "1", JARVIS_PRODUCT_BILLING: "1", JARVIS_ROLE: "brain", JARVIS_BILLING_PROVIDER: "yookassa", JARVIS_LLM_PROXY_URL: "https://x" },
      { JARVIS_PRODUCT_MODE: "no", JARVIS_PRODUCT_QUOTAS: "true" },
    ];
    for (const e of envs) {
      const p = resolveProductFlags(e);
      expect(p).toBe(PRODUCT_OFF);
      expect(p.enabled).toBe(false);
      for (const k of ["auth", "quotas", "billing", "llmProxy", "library", "telemetryEgress"] as const) expect(p[k]).toBe(false);
      expect(p.role).toBe("all");
      expect(p.billingProvider).toBe("none");
    }
  });

  it("мастер включён → auth/quotas/billing по умолчанию true, library/telemetry — false", () => {
    const p = resolveProductFlags({ JARVIS_PRODUCT_MODE: "1" });
    expect(p.enabled).toBe(true);
    expect(p.auth).toBe(true);
    expect(p.quotas).toBe(true);
    expect(p.billing).toBe(true);
    expect(p.library).toBe(false);
    expect(p.telemetryEgress).toBe(false);
    expect(p.role).toBe("all");
    expect(p.billingProvider).toBe("none");
    expect(p.monetization).toBe("hybrid");
  });

  it("подфлаги выключаются точечно; провайдер без billing = none; неизвестная роль → all", () => {
    const p = resolveProductFlags({
      JARVIS_PRODUCT_MODE: "true",
      JARVIS_PRODUCT_AUTH: "0",
      JARVIS_PRODUCT_BILLING: "0",
      JARVIS_BILLING_PROVIDER: "yookassa",
      JARVIS_ROLE: "cloud",
    });
    expect(p.auth).toBe(false);
    expect(p.billing).toBe(false);
    expect(p.billingProvider).toBe("none");
    expect(p.role).toBe("all");
  });

  it("llmProxy требует И подфлаг, И URL", () => {
    expect(resolveProductFlags({ JARVIS_PRODUCT_MODE: "1" }).llmProxy).toBe(false);
    expect(resolveProductFlags({ JARVIS_PRODUCT_MODE: "1", JARVIS_LLM_PROXY_URL: "https://llm.example" }).llmProxy).toBe(true);
    expect(resolveProductFlags({ JARVIS_PRODUCT_MODE: "1", JARVIS_LLM_PROXY_URL: "https://llm.example", JARVIS_PRODUCT_LLM_PROXY: "0" }).llmProxy).toBe(false);
  });

  it("роль/провайдер/токен читаются; describe даёт одну строку", () => {
    const p = resolveProductFlags({ JARVIS_PRODUCT_MODE: "1", JARVIS_ROLE: "node", JARVIS_BILLING_PROVIDER: "fake", JARVIS_ADMIN_TOKEN: " t ", JARVIS_BRAIN_URL: "wss://b" });
    expect(p.role).toBe("node");
    expect(p.billingProvider).toBe("fake");
    expect(p.adminToken).toBe("t");
    expect(p.brainUrl).toBe("wss://b");
    expect(describeProductPolicy(p)).toContain("role=node");
    expect(describeProductPolicy(PRODUCT_OFF)).toBe("product mode OFF");
  });
});
