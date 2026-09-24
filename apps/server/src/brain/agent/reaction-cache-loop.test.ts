/**
 * Ревью 2026-09-24 (T-F6): ответ на короткую РЕАКЦИЮ («нет, не надо», «хорошо») зависит от предыдущей реплики,
 * а семантический кэш ответов ключуется только текстом — сохранённый «Как скажете, сэр» потом подсовывался бы на
 * любое «нет, не надо» в другом разговоре. Проверяем петлёй: store не зовётся для реакции и зовётся для вопроса.
 * Реверт: убери `!opts?.reaction` в loop/terminal.ts — первый тест упадёт.
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { type AgentDeps, handleUserText } from "./index.js";

function run(text: string) {
  const store = vi.fn(async () => undefined);
  const deps = {
    memory: new WorkingMemory(),
    llm: new MockLlmProvider([{ text: "Как скажете, сэр." }]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    responseCache: { lookup: async () => null, store },
  } as unknown as AgentDeps;
  const session = { sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
  return handleUserText(session, text, deps).then(() => store);
}

describe("кэш ответов не хранит ответы на реакции", () => {
  it("«нет, не надо» — ответ в кэш НЕ кладётся", async () => {
    const store = await run("нет, не надо");
    expect(store).not.toHaveBeenCalled();
  });

  it("фактический вопрос — кладётся (кэш жив, гейт узкий)", async () => {
    const store = await run("что такое фотосинтез?");
    expect(store).toHaveBeenCalledTimes(1);
  });
});
