/**
 * §Волна2 (2.7) — тесты пер-раундовой политики thinking: Opus не глушится (грабля §4.7),
 * механика (recall/blind-follow-up) — off, нудж/план — базовый эффорт; стрип thinking-блоков.
 */
import { describe, expect, it } from "vitest";
import type { LlmMessage } from "../../integrations/llm.js";
import { decideRoundThinking, stripThinkingBlocks, thinkingEnabled } from "./thinking-policy.js";

const base = {
  step: 3,
  base: "adaptive" as const,
  tier: "sonnet" as const,
  hasRecalledSkill: false,
  blindMutatePending: false,
  nudgeBoost: false,
};

describe("decideRoundThinking", () => {
  it("конфиг off/undefined — не включаем обратно", () => {
    expect(decideRoundThinking({ ...base, base: "off" })).toBe("off");
    expect(decideRoundThinking({ ...base, base: undefined })).toBeUndefined();
  });

  it("ГРАБЛЯ Opus: fable никогда не глушится, даже на механике", () => {
    expect(decideRoundThinking({ ...base, tier: "fable", hasRecalledSkill: true, blindMutatePending: true })).toBe("adaptive");
  });

  it("первый раунд (план) — думаем", () => {
    expect(decideRoundThinking({ ...base, step: 0, hasRecalledSkill: true })).toBe("adaptive");
  });

  it("нудж-раунд — думаем (переосмысление)", () => {
    expect(decideRoundThinking({ ...base, nudgeBoost: true, hasRecalledSkill: true })).toBe("adaptive");
  });

  it("механика: recall-навык / follow-up после слепого действия → off", () => {
    expect(decideRoundThinking({ ...base, hasRecalledSkill: true })).toBe("off");
    expect(decideRoundThinking({ ...base, blindMutatePending: true })).toBe("off");
  });

  it("обычная середина задачи — как настроено (консервативно)", () => {
    expect(decideRoundThinking(base)).toBe("adaptive");
  });
});

describe("stripThinkingBlocks", () => {
  it("вырезает thinking/redacted из assistant-ходов, не трогая text/tool_use", () => {
    const convo: LlmMessage[] = [
      { role: "user", content: "задача" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "мысль", signature: "sig" },
          { type: "text", text: "делаю" },
          { type: "tool_use", id: "t1", name: "input_click", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    const removed = stripThinkingBlocks(convo);
    expect(removed).toBe(1);
    const a = convo[1]!;
    expect(Array.isArray(a.content) && a.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("страховка: assistant из одних thinking-блоков не остаётся пустым", () => {
    const convo: LlmMessage[] = [
      { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] },
    ];
    stripThinkingBlocks(convo);
    const a = convo[0]!;
    expect(Array.isArray(a.content) && a.content.length).toBe(1);
    expect(Array.isArray(a.content) && a.content[0]!.type).toBe("text");
  });
});

describe("thinkingEnabled", () => {
  it("off/undefined → false; adaptive/число → true", () => {
    expect(thinkingEnabled("off")).toBe(false);
    expect(thinkingEnabled(undefined)).toBe(false);
    expect(thinkingEnabled("adaptive")).toBe(true);
    expect(thinkingEnabled(2048)).toBe(true);
  });
});
