import { describe, expect, it } from "vitest";
import { MODEL_PRICING, costMicroUsd, costUsd, pricingForModel } from "./pricing.js";

describe("pricingForModel — резолв тарифа по id модели", () => {
  it("точный id из каталога — ВЕРСИОННЫЙ тариф (дефект 2026-09-02: Fable 5.1 считался как Opus)", () => {
    expect(pricingForModel("claude-fable-5-1")).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
    expect(pricingForModel("claude-fable-5")).toEqual({ input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 });
    expect(pricingForModel("claude-sonnet-5")).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    expect(pricingForModel("claude-opus-5")).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it("регресс: тарифы 4.6/4.8/Haiku 4.5 не изменились (мастер-флаг 0 = как раньше)", () => {
    expect(pricingForModel("claude-sonnet-4-6")).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(pricingForModel("claude-opus-4-8")).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(pricingForModel("claude-haiku-4-5")).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  it("неизвестный id → семейный фолбэк по подстроке (старший прайс семейства)", () => {
    expect(pricingForModel("claude-sonnet-6")).toBe(MODEL_PRICING.sonnet);
    expect(pricingForModel("claude-fable-6")).toBe(MODEL_PRICING.fable);
    expect(pricingForModel("claude-mythos-5-1")).toBe(MODEL_PRICING.fable);
    expect(pricingForModel("haiku")).toBe(MODEL_PRICING.haiku);
  });

  it("неизвестная/пустая модель → Opus (консервативно, не занижаем траты §14)", () => {
    expect(pricingForModel("")).toBe(MODEL_PRICING.opus);
    expect(pricingForModel("gpt-4o")).toBe(MODEL_PRICING.opus);
  });
});

describe("costUsd — стоимость по фактической модели (чистая)", () => {
  it("1M input+output: Opus = $30, Sonnet 4.6 = $18, Haiku = $6, Fable 5.1 = $60, Sonnet 5 = $12", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(costUsd("claude-opus-4-8", u)).toBeCloseTo(30, 9);
    expect(costUsd("claude-sonnet-4-6", u)).toBeCloseTo(18, 9);
    expect(costUsd("claude-haiku-4-5", u)).toBeCloseTo(6, 9);
    expect(costUsd("claude-fable-5-1", u)).toBeCloseTo(60, 9);
    expect(costUsd("claude-sonnet-5", u)).toBeCloseTo(12, 9);
  });

  it("cache: read 0.1× / write 1.25× от input (Opus, 5m)", () => {
    const read = costUsd("opus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }, { cacheTtl: "5m" });
    const write = costUsd("opus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 }, { cacheTtl: "5m" });
    expect(read).toBeCloseTo(0.5, 9); // 0.1 × $5
    expect(write).toBeCloseTo(6.25, 9); // 1.25 × $5
  });

  it("cache write 1h = 2× input (проект живёт на 1h)", () => {
    const write = costUsd("claude-sonnet-4-6", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 }, { cacheTtl: "1h" });
    expect(write).toBeCloseTo(6, 9);
  });

  it("не-конечные токены коэрсятся в 0 (стрим оборвался → NaN не отравляет spent §14)", () => {
    const u = { inputTokens: Number.NaN, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(costUsd("haiku", u)).toBeCloseTo((100 * 5) / 1_000_000, 12);
  });

  it("нулевой usage = $0", () => {
    expect(costUsd("opus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });

  it("costMicroUsd — целые микро-доллары без потери на округлении до цента", () => {
    const u = { inputTokens: 2279, outputTokens: 146, cacheReadTokens: 36_327, cacheCreationTokens: 4921 };
    const micro = costMicroUsd("claude-sonnet-4-6", u, { cacheTtl: "1h" });
    expect(Number.isInteger(micro)).toBe(true);
    expect(micro).toBe(49_451); // измеренная форма вызова владельца: $0.049451
  });
});
