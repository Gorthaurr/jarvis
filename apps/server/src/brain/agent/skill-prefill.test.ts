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

  // Ревью Волны 3 (#7): дешёвый тир НЕ перетирает записанные литеральные params (иначе модель могла бы
  // подменить combo/method сочинённым значением). Заполняем лишь отсутствующее/пустое.
  it("(#7) не перетирает записанные литеральные params", async () => {
    const withLiteral: SkillStep[] = [
      { action: "input.key", needsLlm: true, params: { combo: "Enter", text: "" } },
    ];
    const out = await prefillNeedsLlmSteps(
      { llm: llmWith('{"0": {"combo": "Ctrl+A", "text": "напечатанное"}}'), model: "m" },
      "t",
      "n",
      withLiteral,
    );
    expect(out).not.toBeNull();
    expect(out![0]!.params).toMatchObject({ combo: "Enter", text: "напечатанное" }); // combo НЕ перетёрт, пустой text заполнен
  });

  // Ревью Волны 3 (#8): расход префилл-вызова прокидывается в onUsage (учёт SpendGuard/COGS).
  it("(#8) зовёт onUsage с токенами вызова", async () => {
    let seen: { inputTokens: number; outputTokens: number } | null = null;
    await prefillNeedsLlmSteps(
      { llm: llmWith('{"1": {"text": "x"}}'), model: "m", onUsage: (u) => (seen = u) },
      "t",
      "n",
      steps,
    );
    expect(seen).not.toBeNull();
    expect(seen!.inputTokens).toBe(1);
    expect(seen!.outputTokens).toBe(1);
  });
});
