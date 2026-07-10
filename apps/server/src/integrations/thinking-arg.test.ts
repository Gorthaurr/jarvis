import { describe, expect, it } from "vitest";
import { thinkingArg } from "./anthropic.js";

// M2 (code-review, 2026-07-04): thinkingArg детектил adaptive-only модели только по /opus/i —
// числовой thinking-бюджет на claude-fable-5 / claude-sonnet-5 строил отвергаемый
// {type:"enabled",budget_tokens} → HTTP 400 → стаб на каждом ходе тира. Теперь allowlist —
// только Sonnet 4.x и раньше принимают enabled+budget, всё остальное честно уходит в adaptive.
describe("thinkingArg — allowlist adaptive-only моделей (M2)", () => {
  it("off/undefined → undefined", () => {
    expect(thinkingArg(undefined, "claude-sonnet-4-6")).toBeUndefined();
    expect(thinkingArg("off", "claude-sonnet-4-6")).toBeUndefined();
  });

  it("adaptive-эффорт → всегда {type:'adaptive'} независимо от модели", () => {
    expect(thinkingArg("adaptive", "claude-sonnet-4-6")).toEqual({ type: "adaptive" });
    expect(thinkingArg("adaptive", "claude-opus-4-8")).toEqual({ type: "adaptive" });
  });

  it("числовой эффорт на claude-fable-5 → adaptive (НЕ enabled/budget, иначе 400)", () => {
    expect(thinkingArg(5000, "claude-fable-5")).toEqual({ type: "adaptive" });
  });

  it("числовой эффорт на claude-sonnet-5 → adaptive (новое семейство, не в allowlist)", () => {
    expect(thinkingArg(5000, "claude-sonnet-5")).toEqual({ type: "adaptive" });
  });

  it("числовой эффорт на claude-opus-4-8 → adaptive (как и раньше)", () => {
    expect(thinkingArg(5000, "claude-opus-4-8")).toEqual({ type: "adaptive" });
  });

  it("числовой эффорт на claude-sonnet-4-6 → enabled+budget_tokens (старое семейство умеет)", () => {
    expect(thinkingArg(5000, "claude-sonnet-4-6")).toEqual({ type: "enabled", budget_tokens: 5000 });
  });
});
