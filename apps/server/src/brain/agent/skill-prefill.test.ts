/**
 * §Волна3 (3.1) — тесты префилла needsLlm-шагов: заполнение дешёвым тиром, честный null
 * на сбое/неполном ответе (реплей вслепую запрещён), нулевая цена без needsLlm-шагов.
 */
import { describe, expect, it } from "vitest";
import type { SkillStep } from "@jarvis/protocol";
import type { ILlmProvider, LlmResponse } from "../../integrations/llm.js";
import { prefillNeedsLlmSteps } from "./skill-prefill.js";

function llmWith(text: string, stubbed = false): ILlmProvider {
  const resp: LlmResponse = {
    text,
    toolUses: [],
    stopReason: stubbed ? "stub" : "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    stubbed,
  };
  return {
    complete: () => Promise.resolve(resp),
    completeStream: () => Promise.resolve(resp),
  } as unknown as ILlmProvider;
}

const steps: SkillStep[] = [
  { action: "app.focus", params: { app: "telegram" } },
  { action: "input.type", needsLlm: true, params: {} },
];

describe("prefillNeedsLlmSteps (§Волна3 3.1)", () => {
  it("без needsLlm-шагов — исходный массив, LLM не зовётся", async () => {
    const plain: SkillStep[] = [{ action: "input.key", params: { combo: "Enter" } }];
    const out = await prefillNeedsLlmSteps({ llm: llmWith("НЕ ДОЛЖЕН ЗВАТЬСЯ"), model: "m" }, "задача", "навык", plain);
    expect(out).toEqual(plain);
  });

  it("заполняет params и снимает needsLlm", async () => {
    const out = await prefillNeedsLlmSteps(
      { llm: llmWith('{"1": {"text": "привет, опоздаю на 10 минут"}}'), model: "m" },
      "напиши кате что опоздаю",
      "написать в телеграм",
      steps,
    );
    expect(out).not.toBeNull();
    expect(out![1]!.needsLlm).toBe(false);
    expect(out![1]!.params).toMatchObject({ text: "привет, опоздаю на 10 минут" });
    expect(out![0]).toMatchObject({ action: "app.focus" }); // нетронутый шаг цел
  });

  it("невалидный JSON / пустые params / стаб → null (реплей вслепую запрещён)", async () => {
    expect(await prefillNeedsLlmSteps({ llm: llmWith("не json"), model: "m" }, "t", "n", steps)).toBeNull();
    expect(await prefillNeedsLlmSteps({ llm: llmWith('{"1": {}}'), model: "m" }, "t", "n", steps)).toBeNull();
    expect(await prefillNeedsLlmSteps({ llm: llmWith("{}", true), model: "m" }, "t", "n", steps)).toBeNull();
  });
});
