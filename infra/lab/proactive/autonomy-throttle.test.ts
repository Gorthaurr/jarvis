/**
 * Часовой предохранитель автономных LLM-вызовов на НАСТОЯЩЕМ проверяльщике наблюдения (createWatchChecker): скользящее окно
 * 1 час на виртуальных часах, отказ = «не смог проверить» (транзиент), а не «условие не выполнено» и не провал для dead-watch.
 */
import { describe, it } from "vitest";
import { autonomyThrottle } from "../../../apps/server/src/autonomy/throttle.js";
import type { ILlmProvider, LlmResponse } from "../../../apps/server/src/integrations/llm.js";
import { createWatchChecker } from "../../../apps/server/src/proactive/watch/checker.js";
import { OWNER, secs, useLab, watch } from "./helpers.js";
import { expect } from "./kit.js";
import type { ProactiveLab } from "./lab.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Мозг проверяльщика по сценарию: каждый вызов - report{met:false}; времена вызовов пишутся. */
function reportingLlm(calls: number[]): ILlmProvider {
  const reply = (): LlmResponse => {
    calls.push(Date.now());
    return {
      text: "", stopReason: "tool_use", stubbed: false,
      toolUses: [{ id: `t${calls.length}`, name: "report", input: { met: false, summary: "" } }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  };
  return { live: true, complete: async () => reply(), completeStream: async () => reply() };
}

function useChecker(lab: ProactiveLab, calls: number[]): void {
  lab.script.checker = createWatchChecker({
    llm: reportingLlm(calls), web: { live: false, search: async () => [], fetch: async () => null }, tier: "sonnet", model: "lab",
  });
}

describe("часовой предохранитель (лимит 3 вызова в час)", () => {
  const t = useLab({ start: "2026-07-29T08:00:00", llmPerHour: 3 });

  it("после лимита проверки не идут в LLM, окно скользит: следующие вызовы ровно через час после первых", async () => {
    const { lab } = t;
    lab.connect();
    const t0 = lab.clock.now();
    const calls: number[] = [];
    useChecker(lab, calls);
    let blocked = 0;
    autonomyThrottle().setOnBlocked(() => (blocked += 1));
    watch(lab, { intervalMs: MIN });
    await lab.clock.advance(HOUR - 1);
    expect(secs(calls, t0)).toEqual([0, 60, 120]); // 3 слота съедены за первые 3 минуты
    expect(blocked).toBe(57); // остальные 57 тиков часа отказаны, а не потрачены
    await lab.clock.advance(HOUR / 2);
    expect(secs(calls, t0)).toEqual([0, 60, 120, 3600, 3660, 3720]); // окно освободилось строго по расписанию
  });

  it("отказ предохранителя не убивает наблюдение: не suspended, «не смог наблюдать» не звучит, met не выдумывается", async () => {
    const { lab } = t;
    lab.connect();
    useChecker(lab, []);
    watch(lab, { intervalMs: MIN });
    await lab.clock.advance(HOUR - 1); // 57 отказов подряд при пороге dead-watch 10
    expect(lab.svc.watch.list({ userId: OWNER })).toHaveLength(1);
    expect(lab.spoken()).toEqual([]);
  });
});
