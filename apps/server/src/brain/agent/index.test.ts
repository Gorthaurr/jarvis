import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { Session } from "../../gateway/session.js";
import { TaskManager } from "../tasks/manager.js";
import type { TaskStatus } from "@jarvis/protocol";
import { type AgentDeps, handleUserText } from "./index.js";

function fakeSession(
  sendAction = vi.fn((_cmd: ActionCommand, _t?: number) =>
    Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }),
  ),
) {
  // send — приёмник конвертов (task.status §20 и пр.); в тестах пишем в шпион.
  const send = vi.fn();
  return { sessionId: "s1", userId: "u1", sendAction, send } as unknown as Session & {
    sendAction: typeof sendAction;
    send: typeof send;
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
    // Инструменты предложены модели; message_send (M6) и order_place (M7) доступны
    // под гардами §14; skill_execute/demo_record инициируются иначе и не предлагаются.
    const toolNames = (llm.requests[0]?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("message_send");
    expect(toolNames).toContain("order_place");
    expect(toolNames).not.toContain("skill_execute");
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

  it("M8 §20: стримит task.status running → done на многошаговой задаче", async () => {
    const tasks = new TaskManager();
    const statuses: TaskStatus[] = [];
    const send = vi.fn((type: string, payload: unknown) => {
      if (type === "task.status") statuses.push(payload as TaskStatus);
    });
    const sendAction = vi.fn(() => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
    const session = { sessionId: "s1", userId: "u1", sendAction, send } as unknown as Session;
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "memory_search", input: { query: "зал" } }] },
      { text: "Посмотрел, готово." },
    ]);
    await handleUserText(session, "что у меня в памяти про зал, разверни", await makeDeps(llm, { tasks }));

    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses.some((s) => s.state === "running")).toBe(true);
    expect(statuses[statuses.length - 1]?.state).toBe("done");
    expect(tasks.list("u1")[0]?.state).toBe("done");
  });

  it("M8 §20: отмена в петле останавливает задачу (≤1 шага), state cancelled", async () => {
    const tasks = new TaskManager();
    // Имитируем приход task.control(cancel): как только пришёл прогресс — отменяем задачу.
    const send = vi.fn((type: string, payload: unknown) => {
      const s = payload as TaskStatus;
      if (type === "task.status" && s.state === "running" && (s.stepsDone ?? 0) >= 1) {
        tasks.cancel(s.taskId);
      }
    });
    const sendAction = vi.fn(() => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
    const session = { sessionId: "s1", userId: "u1", sendAction, send } as unknown as Session;
    // Модель всё время просит инструмент — петля бесконечна, остановит только отмена.
    const llm = new MockLlmProvider(
      Array.from({ length: 10 }, () => ({
        toolUses: [{ id: "t", name: "memory_search", input: { query: "x" } }],
      })),
    );
    const reply = await handleUserText(session, "сделай долгую многошаговую работу", await makeDeps(llm, { tasks }));

    expect(reply.voice.toLowerCase()).toContain("останов");
    expect(tasks.list("u1")[0]?.state).toBe("cancelled");
    // Отмена ≤1 шага: после прогресса №1 петля не успевает уйти далеко.
    expect(llm.requests.length).toBeLessThanOrEqual(3);
  });
});
