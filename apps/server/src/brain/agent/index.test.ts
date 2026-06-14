import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { Session } from "../../gateway/session.js";
import { type AgentDeps, handleUserText } from "./index.js";

function fakeSession(
  sendAction = vi.fn((_cmd: ActionCommand, _t?: number) =>
    Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }),
  ),
) {
  return { sessionId: "s1", userId: "u1", sendAction } as unknown as Session & {
    sendAction: typeof sendAction;
  };
}

async function makeDeps(llm: MockLlmProvider, overrides: Partial<AgentDeps> = {}): Promise<AgentDeps> {
  const episodic = new InMemoryEpisodicMemory(new HashEmbeddingProvider());
  return {
    memory: new WorkingMemory(),
    llm,
    episodic,
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    ...overrides,
  };
}

describe("agent-loop (§7, §8)", () => {
  it("tier0: «открой блокнот» → ActionCommand app.launch (без LLM)", async () => {
    const session = fakeSession();
    const llm = new MockLlmProvider();
    const reply = await handleUserText(session, "открой блокнот", await makeDeps(llm));
    expect(session.sendAction).toHaveBeenCalledTimes(1);
    const cmd = session.sendAction.mock.calls[0]?.[0];
    expect(cmd?.kind).toBe("app.launch");
    expect(reply.voice.toLowerCase()).toContain("открыл");
    expect(llm.requests).toHaveLength(0); // tier0 не зовёт LLM
  });

  it("tool-use: memory_search → финальный ответ (retrieval §8)", async () => {
    const session = fakeSession();
    const deps = await makeDeps(
      new MockLlmProvider([
        { toolUses: [{ id: "t1", name: "memory_search", input: { query: "зал" } }] },
        { text: "Ты в зал ходишь по понедельникам." },
      ]),
    );
    await deps.episodic.write({ userId: "u1", kind: "fact", text: "ходит в зал по понедельникам", ts: 1 });

    const reply = await handleUserText(session, "что там у меня с залом", deps);
    expect(reply.voice).toContain("зал");
    const llm = deps.llm as MockLlmProvider;
    expect(llm.requests).toHaveLength(2);
    // Инструменты предложены модели, но необратимые (M6/M7) исключены.
    const toolNames = (llm.requests[0]?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).not.toContain("message_send");
    expect(toolNames).not.toContain("order_place");
  });

  it("actuator tool из петли → session.sendAction", async () => {
    const session = fakeSession();
    const deps = await makeDeps(
      new MockLlmProvider([
        { toolUses: [{ id: "t1", name: "app_launch", input: { app: "calc" } }] },
        { text: "Открыл калькулятор." },
      ]),
    );
    await handleUserText(session, "посчитай что-нибудь сложное и многошаговое", deps);
    const cmd = session.sendAction.mock.calls[0]?.[0];
    expect(cmd?.kind).toBe("app.launch");
    expect((cmd as { app: string }).app).toBe("calc");
  });

  it("предохранитель: лимит шагов останавливает петлю (§14)", async () => {
    const session = fakeSession();
    // Модель всегда просит инструмент → без лимита петля бесконечна.
    const llm = new MockLlmProvider(
      Array.from({ length: 10 }, () => ({
        toolUses: [{ id: "t", name: "memory_search", input: { query: "x" } }],
      })),
    );
    const deps = await makeDeps(llm, { spend: new SpendGuard({ maxStepsPerTask: 2 }) });
    const reply = await handleUserText(session, "сделай что-то бесконечное и сложное", deps);
    expect(reply.voice.toLowerCase()).toContain("лимит");
    expect(llm.requests.length).toBeLessThanOrEqual(3);
  });
});
