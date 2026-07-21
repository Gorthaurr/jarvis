import { describe, expect, it } from "vitest";
import type { ILlmProvider, LlmDelta, LlmRequest, LlmResponse, ToolUse } from "../../integrations/llm.js";
import { type ExpertContext, TradeExpert } from "./expert.js";

/** Фейк LLM: отдаёт заданный tool_use с stubbed=false (реальный ответ); пишет запросы для ассертов. */
class FakeLlm implements ILlmProvider {
  readonly live = true;
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly uses: ToolUse[] = [],
    private readonly stubbed = false,
  ) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    return {
      text: "",
      toolUses: this.uses,
      stopReason: this.uses.length > 0 ? "tool_use" : "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stubbed: this.stubbed,
    };
  }
  completeStream(req: LlmRequest, _onDelta: (d: LlmDelta) => void): Promise<LlmResponse> {
    return this.complete(req);
  }
}

const knowledge = {
  consult: () => ({ found: true, matched: true, text: "## Размер позиции от риска\nстоп от структуры, R:R≥2", topics: [] as string[] }),
};

const ctx = (over: Partial<ExpertContext> = {}): ExpertContext => ({
  symbol: "BTCUSDT",
  market: "crypto",
  interval: "4h",
  entryPrice: 100,
  facts: ["структура восходящая HH/HL", "у поддержки 96", "объём 1.6×"],
  atr: 3,
  support: 96,
  resistance: 112,
  screenReason: "тренд↑, у поддержки",
  baseRate: { upRate: 0.6, samples: 120 },
  ...over,
});

const decision = (input: Record<string, unknown>): ToolUse[] => [{ id: "t1", name: "submit_trade_decision", input }];

const make = (uses: ToolUse[], stubbed = false): TradeExpert =>
  new TradeExpert(new FakeLlm(uses, stubbed), knowledge, { model: "claude-opus-4-8", tier: "fable" });

describe("TradeExpert (§трейдинг слой 2: LLM в петле прогноза)", () => {
  it("валидное решение (лонг: стоп ниже, тейк выше, R:R≥2) → возвращает с уверенностью", async () => {
    const d = await make(decision({ act: true, direction: "up", stopPrice: 97, targetPrice: 110, confidence: 0.7, rationale: "по тренду от поддержки" })).decide(ctx());
    expect(d).not.toBeNull();
    expect(d!.direction).toBe("up");
    expect(d!.stopPrice).toBe(97);
    expect(d!.targetPrice).toBe(110);
    expect(d!.confidence).toBeCloseTo(0.7, 6);
  });

  it("act=false → пас (null)", async () => {
    expect(await make(decision({ act: false })).decide(ctx())).toBeNull();
  });

  it("стоп НЕ с той стороны (лонг, стоп ВЫШЕ входа) → пас", async () => {
    expect(await make(decision({ act: true, direction: "up", stopPrice: 103, targetPrice: 110, confidence: 0.8 })).decide(ctx())).toBeNull();
  });

  it("R:R ниже 1.5 (риск 3, профит 1) → пас", async () => {
    expect(await make(decision({ act: true, direction: "up", stopPrice: 97, targetPrice: 101, confidence: 0.6 })).decide(ctx())).toBeNull();
  });

  it("шорт: стоп выше входа, тейк ниже, R:R≥2 → ок", async () => {
    const d = await make(decision({ act: true, direction: "down", stopPrice: 103, targetPrice: 90, confidence: 0.6 })).decide(ctx());
    expect(d).not.toBeNull();
    expect(d!.direction).toBe("down");
  });

  it("уверенность клампится в [0,1]", async () => {
    const d = await make(decision({ act: true, direction: "up", stopPrice: 97, targetPrice: 110, confidence: 5 })).decide(ctx());
    expect(d!.confidence).toBe(1);
  });

  it("стаб/нет реального бэкенда → пас (не плодим мусорные прогнозы)", async () => {
    expect(await make(decision({ act: true, direction: "up", stopPrice: 97, targetPrice: 110 }), true).decide(ctx())).toBeNull();
  });

  it("нет вызова submit_trade_decision → пас", async () => {
    expect(await make([{ id: "x", name: "other_tool", input: {} }]).decide(ctx())).toBeNull();
  });

  it("бюджет-кап: после исчерпания LLM больше НЕ вызывается (пас, requests не растёт)", async () => {
    const llm = new FakeLlm(decision({ act: true, direction: "up", stopPrice: 97, targetPrice: 110, confidence: 0.7 }));
    // budget крошечный — первый вызов проходит и сразу превышает (usage {1,1} по Opus = $0.00003)
    const e = new TradeExpert(llm, knowledge, { model: "claude-opus-4-8", tier: "fable", budgetUsd: 0.00001 });
    expect(await e.decide(ctx())).not.toBeNull(); // 1-й проходит (бюджет не превышен ДО вызова)
    expect(e.spentUsd()).toBeGreaterThan(0);
    expect(e.budgetExhausted()).toBe(true);
    const reqs = llm.requests.length;
    expect(await e.decide(ctx())).toBeNull(); // 2-й — бюджет исчерпан
    expect(llm.requests.length).toBe(reqs); // LLM не вызван второй раз
  });

  it("в запрос уходят факты, выдержка базы знаний и tool решения", async () => {
    const llm = new FakeLlm(decision({ act: true, direction: "up", stopPrice: 97, targetPrice: 110, confidence: 0.7 }));
    await new TradeExpert(llm, knowledge, { model: "m", tier: "fable" }).decide(ctx());
    const req = llm.requests[0]!;
    const userText = typeof req.messages[0]!.content === "string" ? (req.messages[0]!.content as string) : "";
    expect(userText).toContain("структура восходящая");
    expect(userText).toContain("Размер позиции от риска");
    expect(req.tools?.[0]?.name).toBe("submit_trade_decision");
    expect(req.model).toBe("m");
  });
});
