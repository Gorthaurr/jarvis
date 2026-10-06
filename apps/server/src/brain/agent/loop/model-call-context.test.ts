import { expect, it, vi } from "vitest";
import { accountRound } from "./model-call.js";
import type { LoopCtx } from "./context.js";

it("отложенный накопленный расход не становится размером окна в гарде следующего раунда", () => {
  const recordUsage = vi.fn();
  const state = {
    usage: { taskChargedUsd: 0, inputTokensTotal: 0, outputTokensTotal: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCallsTotal: 0 },
    tier: { model: "codex", currentTier: "sonnet" }, progress: { round: 1 },
    budget: { lastPromptTokens: 0, pendingResultTokens: 100, prunedLastRound: false, maskedLastRound: false },
  };
  const ctx = { st: state, deps: { spend: { recordUsage } }, taskId: "context-test" } as unknown as LoopCtx;
  accountRound(ctx, 1, { text: "", toolUses: [], stopReason: "end_turn", stubbed: false, channel: "subscription",
    contextTokens: 100_000, usage: { inputTokens: 200_000, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 } }, Date.now());
  expect(state.budget.lastPromptTokens).toBe(100_000);
  expect(state.usage.inputTokensTotal).toBe(200_000);
  expect(recordUsage).toHaveBeenCalledWith("context-test", 200_020, 0);
});
