/**
 * 🔴 Лог 2026-09-02, 17:03: владелец разговаривал с человеком в комнате и сказал «Нет, Джарвис, не
 * тебе.» — система завела фоновую sonnet-ЗАДАЧУ «Нет не тебе» (12.8 с, 563 выходных токена), которая
 * потом висела активной и путала scope соседних реплик («§20 область реплики при активной задаче
 * {active: "Нет не тебе"}»). Реплика, адресованная НЕ Джарвису, не должна ни стоить денег, ни
 * оставлять задачу — и отвечать на неё тоже не надо: человека перебивать незачем.
 *
 * Проверяем ПЕТЛЁЙ: перехват стоит до маршрутизации, чистая функция этого не докажет.
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

const session = () =>
  ({ sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() }) as unknown as Session;

function deps(llm: MockLlmProvider, tasks: TaskManager): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
  } as AgentDeps;
}

describe("реплика не Джарвису", () => {
  it("«Нет, Джарвис, не тебе» — ни задачи, ни обращения к модели, ни ответа", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([{ text: "Понял, сэр." }]);
    const r = await handleUserText(session(), "Нет, Джарвис, не тебе.", deps(llm, tasks));
    expect(llm.requests).toHaveLength(0); // модель не вызывалась — ход бесплатный
    expect(tasks.toJSON().tasks).toHaveLength(0); // и в реестре ничего не осталось
    expect(r.voice).toBe(""); // молчим: человека, сказавшего «не тебе», перебивать не надо
  });

  it("похожая, но АДРЕСОВАННАЯ реплика идёт обычным путём", async () => {
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([{ text: "Включаю, сэр." }]);
    await handleUserText(session(), "не тебе решать, включи музыку", deps(llm, tasks));
    expect(llm.requests.length).toBeGreaterThan(0); // гард узкий — обычная команда доходит до модели
  });
});
