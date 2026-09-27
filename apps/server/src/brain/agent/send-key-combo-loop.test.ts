/**
 * W1-ревью р2 (loop-bypass-1): петля узнаёт клавишу-«отправку» тем же разбором combo, что §14-гейт и расширение
 * (@jarvis/shared parseKeyCombo): «Enter+Ctrl» расширение шлёт как Ctrl+Enter — это отправка, долг сверки её исхода;
 * Shift+Enter — перенос строки, не отправка. ПЕТЛЁЙ (handleUserText); хендлер подменён, но в его настоящей форме.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import type { ToolResult } from "../tools/dispatch.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

vi.mock("../tools/dispatch.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tools/dispatch.js")>();
  return { ...mod, dispatchTool: vi.fn(mod.dispatchTool) };
});
const { dispatchTool } = await import("../tools/dispatch.js");

beforeEach(() => {
  // Форма ответа browserAct с readback поля (observed) — набор сверен, исход отправки — нет.
  vi.mocked(dispatchTool).mockImplementation(async (name, input): Promise<ToolResult> => {
    if (name !== "browser_act") throw new Error(`в тесте не ожидался вызов ${name}`);
    return { content: `Сделал «${String((input as { intent?: unknown }).intent)}» в браузере.`, isError: false, observed: true };
  });
});

const session = () => ({ sessionId: "s1", userId: "u1", sendAction: vi.fn(), send: vi.fn(), requestConfirm: vi.fn() }) as unknown as Session;
const deps = (llm: MockLlmProvider): AgentDeps => ({
  memory: new WorkingMemory(),
  llm,
  episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
  web: new MockWebProvider(),
  models: { haiku: "h", sonnet: "s", fable: "f" },
  spend: new SpendGuard(),
  userId: "u1",
  tasks: new TaskManager(),
});
const act = (id: string, input: Record<string, unknown>): MockTurn => ({ toolUses: [{ id, name: "browser_act", input }] });
const done = (text: string): MockTurn[] => [{ text }, { text }, { text }];
const verifyNudged = (llm: MockLlmProvider): boolean => JSON.stringify(llm.requests).includes("лестница §Волна3");

describe("клавиша-отправка после набора — общий разбор combo", () => {
  it.each(["Enter+Ctrl", "ctrl + enter", "Meta+Return"])("набор → key «%s» (расширение жмёт Enter) → «Отправлено» без взгляда получает нудж", async (combo) => {
    const llm = new MockLlmProvider([act("t1", { intent: "type", ref: "e2_1", text: "буду в семь" }), act("k1", { intent: "key", ref: "e2_1", combo }), ...done("Отправлено, сэр.")]);
    await handleUserText(session(), "напиши Кате в чате на сайте что буду в семь", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("набор → Shift+Enter (перенос строки) — не отправка: сверенный набор, нуджа нет", async () => {
    const llm = new MockLlmProvider([act("t1", { intent: "type", ref: "e2_1", text: "буду в семь" }), act("k1", { intent: "key", ref: "e2_1", combo: "Shift+Enter" }), ...done("Вписал две строки, сэр.")]);
    await handleUserText(session(), "впиши в поле чата на сайте буду в семь и перенос строки", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
  });
});
