/**
 * Контракт completeStream (§10 realtime token-streaming): на text-ходе текст приходит
 * дельтами, на tool-ходе — без текста; ключевой инвариант «сумма дельт === resp.text».
 */
import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "./llm.js";

const req = {
  tier: "haiku" as const,
  model: "h",
  systemStatic: "p",
  messages: [{ role: "user" as const, content: "привет" }],
};

describe("MockLlmProvider.completeStream (§10)", () => {
  it("text-ход: дельты собираются ровно в resp.text", async () => {
    const llm = new MockLlmProvider([{ text: "Привет, сэр. Чем помочь?" }]);
    const deltas: string[] = [];
    const resp = await llm.completeStream(req, (d) => deltas.push(d.text));
    expect(deltas.join("")).toBe("Привет, сэр. Чем помочь?");
    expect(deltas.length).toBeGreaterThan(1); // реально стримили по кускам, не одним блоком
    expect(resp.text).toBe("Привет, сэр. Чем помочь?");
    expect(resp.stopReason).toBe("end_turn");
  });

  it("tool-ход: текста нет → дельт нет, toolUses проброшены", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "web_read", input: {} }] },
    ]);
    const deltas: string[] = [];
    const resp = await llm.completeStream(req, (d) => deltas.push(d.text));
    expect(deltas).toEqual([]);
    expect(resp.toolUses).toHaveLength(1);
    expect(resp.stopReason).toBe("tool_use");
  });

  it("последовательные ходы используют следующий скрипт-ход", async () => {
    const llm = new MockLlmProvider([{ text: "Первое." }, { text: "Второе." }]);
    const a: string[] = [];
    const b: string[] = [];
    await llm.completeStream(req, (d) => a.push(d.text));
    await llm.completeStream(req, (d) => b.push(d.text));
    expect(a.join("")).toBe("Первое.");
    expect(b.join("")).toBe("Второе.");
  });
});
