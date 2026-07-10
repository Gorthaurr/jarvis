import { describe, expect, it } from "vitest";
import { MockLlmProvider } from "../../integrations/llm.js";
import type { IWebProvider } from "../../integrations/web.js";
import { createWatchChecker } from "./checker.js";
import type { Watch } from "./watch.js";

const fakeWeb: IWebProvider = {
  live: false,
  search: async () => [{ title: "Bitcoin price", url: "https://ex.com", snippet: "BTC сейчас 58 000 USD" }],
  fetch: async () => null,
};

const W: Watch = {
  id: "w",
  sessionId: "s",
  userId: "u",
  what: "курс биткоина",
  condition: "ниже 60000",
  intervalMs: 60_000,
  continuous: false,
  status: "active",
  createdAt: 0,
};

describe("createWatchChecker — LLM добывает факт и решает met", () => {
  it("ищет в вебе → report(met:true) → возвращает результат", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "web_search", input: { query: "курс биткоина сейчас" } }] },
      { toolUses: [{ id: "t2", name: "report", input: { met: true, value: "58000 USD", summary: "Биткоин упал ниже 60000 — сейчас 58 000." } }] },
    ]);
    const check = createWatchChecker({ llm, web: fakeWeb, model: "m", tier: "sonnet" });
    const r = await check(W);
    expect(r.met).toBe(true);
    expect(r.value).toBe("58000 USD");
    expect(r.summary).toContain("58");
    // в LLM ушёл tool_result поиска (фид факта обратно)
    expect(JSON.stringify(llm.requests[1]?.messages ?? [])).toContain("58 000 USD");
  });

  it("модель не вызвала report (end_turn) → met:false + error (не выдумываем срабатывание)", async () => {
    const llm = new MockLlmProvider([{ text: "затрудняюсь", stopReason: "end_turn" }]);
    const check = createWatchChecker({ llm, web: fakeWeb, model: "m", tier: "sonnet" });
    const r = await check(W);
    expect(r.met).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("ошибка LLM → met:false + error (наблюдение не падает, повтор в след. тик)", async () => {
    const llm = new MockLlmProvider();
    (llm as unknown as { complete: () => Promise<never> }).complete = async () => {
      throw new Error("сеть недоступна");
    };
    const check = createWatchChecker({ llm, web: fakeWeb, model: "m", tier: "sonnet" });
    const r = await check(W);
    expect(r.met).toBe(false);
    expect(r.error).toContain("сеть");
  });
});
