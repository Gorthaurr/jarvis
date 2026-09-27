/**
 * A1 (прод 26.09, разбор боевых логов): окно разговора приняло звук фильма БЕЗ «Джарвис» (viaWake=false) —
 * перехват эмоции навсегда записал в профиль подачу «angry», а модель через memory_write — выдуманное «правило
 * владельца». ПЕТЛЁЙ (handleUserText): реплика без обращения долговременное не меняет; та же реплика с
 * обращением — меняет (контроль: гейт не сломал саму функцию).
 * Реверт: убери skipUnaddressed из interceptEmotion — упадёт первый тест; убери гейт unaddressedTurn в
 * memoryWrite (dispatch.ts) — упадёт второй.
 */
import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { getProfile } from "../profile.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

const session = (userId: string) =>
  ({ sessionId: `s-${userId}`, userId, sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() }) as unknown as Session;
const deps = (llm: MockLlmProvider, userId: string): AgentDeps => ({
  memory: new WorkingMemory(),
  llm,
  episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
  web: new MockWebProvider(),
  models: { haiku: "h", sonnet: "s", fable: "f" },
  spend: new SpendGuard(),
  userId,
  tasks: new TaskManager(),
});
const call = (id: string, name: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name, input }] });

/** tool_result вызова `id` из последнего запроса к модели. */
function result(llm: MockLlmProvider, id: string): { content: string; isError: boolean } {
  for (const req of [...llm.requests].reverse()) {
    for (const m of req.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
        if (b.type === "tool_result" && b.tool_use_id === id) return { content: JSON.stringify(b.content), isError: b.is_error === true };
      }
    }
  }
  throw new Error(`нет tool_result для ${id}`);
}

describe("A1: реплика без обращения «Джарвис» не меняет долговременное", () => {
  it("«говори зло» без обращения → эмоция в профиле НЕ сохранена; с обращением — сохранена", async () => {
    await handleUserText(session("ua1"), "говори зло", deps(new MockLlmProvider([{ text: "Ладно." }]), "ua1"), undefined, { viaWake: false });
    expect(getProfile("ua1").emotion).not.toBe("angry");

    await handleUserText(session("ua2"), "говори зло", deps(new MockLlmProvider([{ text: "Ладно." }]), "ua2"), undefined, { viaWake: true });
    expect(getProfile("ua2").emotion).toBe("angry");
  });

  it("memory_write из реплики без обращения → отказ (НЕ записал); с обращением — записано", async () => {
    const FACT = { content: "Владелец запретил присылать голосовые сообщения", kind: "preference" };
    const llmA = new MockLlmProvider([call("m1", "memory_write", FACT), { text: "Понял." }, { text: "Понял." }]);
    await handleUserText(session("ub1"), "никаких голосовых сообщений больше", deps(llmA, "ub1"), undefined, { viaWake: false });
    const refused = result(llmA, "m1");
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/НЕ записал/u);

    const llmB = new MockLlmProvider([call("m2", "memory_write", FACT), { text: "Понял." }, { text: "Понял." }]);
    await handleUserText(session("ub2"), "никаких голосовых сообщений больше", deps(llmB, "ub2"), undefined, { viaWake: true });
    const written = result(llmB, "m2");
    expect(written.isError).toBe(false);
    expect(written.content).not.toMatch(/НЕ записал/u);
  });
});
