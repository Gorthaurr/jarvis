/** Провайдер Ollama проходит ту же петлю и те же проверки результата, что Claude. */
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../gateway/session.js";
import { OllamaLlmProvider } from "../../integrations/ollama-llm.js";
import { WorkingMemory } from "../../memory/working.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { SpendGuard } from "../../billing/index.js";
import { TaskManager } from "../tasks/manager.js";
import { handleUserText, type AgentDeps } from "./index.js";

describe("no API provider in Jarvis loop", () => {
  it("действие проходит через Session; отказ не превращается в успех; расход local = 0", async () => {
    const bodies: any[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ done: true, model: "qwen-test", prompt_eval_count: 500, eval_count: 10,
        message: bodies.length === 1
          ? { content: "", tool_calls: [{ function: { name: "input_click", arguments: { target: { by: "coords", x: 100, y: 200, frame: "f1" } } } }] }
          : { content: "Задача не выполнена: ввод занят другой задачей." } }));
    });
    const llm = new OllamaLlmProvider("qwen-test", "http://127.0.0.1:1", fetcher as typeof fetch, 131072);
    const session = { sessionId: "no-api-session", userId: "local-user", send: vi.fn(), sendAction: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
    const tasks = new TaskManager(); const usageSink = vi.fn();
    const deps = { memory: new WorkingMemory(), llm, episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
      web: new MockWebProvider(), models: { haiku: "h", sonnet: "s", fable: "f" }, spend: new SpendGuard(), userId: "local-user", tasks, usageSink,
      inputArbiter: { locked: true, acquireWithTimeout: async () => false, acquire: async () => undefined, release: () => undefined },
    } as unknown as AgentDeps;
    await handleUserText(session, "нажми кнопку играть", deps);
    expect(session.sendAction).not.toHaveBeenCalled();
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies[1].messages.some((m: any) => m.role === "tool" && m.content.includes("ОШИБКА ИНСТРУМЕНТА"))).toBe(true);
    expect(tasks.toJSON().tasks[0]?.state).toBe("failed");
    expect(usageSink).toHaveBeenCalledWith(expect.objectContaining({ channel: "local", costUsd: 0, model: "qwen-test" }));
  });
});
