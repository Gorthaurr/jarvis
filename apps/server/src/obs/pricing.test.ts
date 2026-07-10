import { describe, expect, it } from "vitest";
import { MODEL_PRICING, costUsd, pricingForModel } from "./pricing.js";

describe("pricingForModel — резолв тарифа по id модели", () => {
  it("матчит семейство по подстроке id", () => {
    expect(pricingForModel("claude-haiku-4-5")).toBe(MODEL_PRICING.haiku);
    expect(pricingForModel("claude-sonnet-4-6")).toBe(MODEL_PRICING.sonnet);
    expect(pricingForModel("claude-opus-4-8")).toBe(MODEL_PRICING.opus);
    expect(pricingForModel("claude-fable-5")).toBe(MODEL_PRICING.fable);
  });

  it("неизвестная/пустая модель → Opus (консервативно, не занижаем траты §14)", () => {
    expect(pricingForModel("")).toBe(MODEL_PRICING.opus);
    expect(pricingForModel("gpt-4o")).toBe(MODEL_PRICING.opus);
  });
});

describe("costUsd — стоимость по фактической модели (чистая)", () => {
  it("1M input+output: Opus = $30, Sonnet = $18, Haiku = $6", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(costUsd("claude-opus-4-8", u)).toBeCloseTo(30, 9);
    expect(costUsd("claude-sonnet-4-6", u)).toBeCloseTo(18, 9);
    expect(costUsd("claude-haiku-4-5", u)).toBeCloseTo(6, 9);
  });

  it("cache: read 0.1× / write 1.25× от input (Opus)", () => {
    const read = costUsd("opus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 });
    const write = costUsd("opus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 });
    expect(read).toBeCloseTo(0.5, 9); // 0.1 × $5
    expect(write).toBeCloseTo(6.25, 9); // 1.25 × $5
  });

  it("не-конечные токены коэрсятся в 0 (стрим оборвался → NaN не отравляет spent §14)", () => {
    const u = { inputTokens: Number.NaN, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(costUsd("haiku", u)).toBeCloseTo((100 * 5) / 1_000_000, 12);
  });

  it("нулевой usage = $0", () => {
    expect(costUsd("opus", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });
});
