/**
 * Ревью 2026-09-24 (B-F6): «вырубись/отмени» посреди раунда обязан остановить ЛЮБОЙ ещё не исполненный вызов,
 * а не только GUI (аренда ввода). Раньше отмена проверялась лишь перед кликами: отправка человеку, code_run,
 * fs_delete из того же раунда исполнялись ПОСЛЕ «Остановил». Проверяем петлёй и шпионом на dispatchTool.
 * Реверт-проверка: убери `if (ctx.task.cancel.cancelled) break;` в loop/tool-round.ts — оба теста упадут
 * (telegram_send дойдёт до диспетчера).
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { type LlmRequest, type LlmResponse, MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

vi.mock("../tools/dispatch.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tools/dispatch.js")>();
  return { ...mod, dispatchTool: vi.fn(mod.dispatchTool) };
});
const { dispatchTool } = await import("../tools/dispatch.js");

const SEND = { id: "s1", name: "telegram_send", input: { to: "Катя", text: "я приду в семь" } };

/** Модель, в момент ответа которой владелец говорит «отмени» (задача отменяется, пока модель думала). */
class CancelWhileThinking extends MockLlmProvider {
  constructor(script: MockTurn[], private readonly onCall: () => void) {
    super(script);
  }
  override async complete(req: LlmRequest): Promise<LlmResponse> {
    this.onCall();
    return super.complete(req);
  }
}

function base(llm: MockLlmProvider, tasks: TaskManager, sendAction: ReturnType<typeof vi.fn>) {
  const session = { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
  const deps: AgentDeps = {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks,
  };
  return { session, deps };
}

const called = (name: string): boolean => vi.mocked(dispatchTool).mock.calls.some((c) => c[0] === name);

describe("B-F6: отмена посреди раунда — не-GUI вызовы тоже не исполняются", () => {
  it("«отмени», пока модель думала → раунд с telegram_send НЕ диспатчится, задача cancelled, ответ тихий", async () => {
    vi.mocked(dispatchTool).mockClear();
    const tasks = new TaskManager();
    const llm = new CancelWhileThinking([{ toolUses: [SEND] }, { text: "Отправил." }], () => tasks.cancelUser("u1"));
    const sendAction = vi.fn((_c: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
    const { session, deps } = base(llm, tasks, sendAction);
    const reply = await handleUserText(session, "напиши Кате что я приду в семь", deps);
    expect(called("telegram_send")).toBe(false);
    expect(tasks.list("u1")[0]?.state).toBe("cancelled");
    expect(reply.voice).toBe("");
  });

  it("отмена во время ПЕРВОГО вызова раунда (fs_read) → второй (telegram_send) не исполняется", async () => {
    vi.mocked(dispatchTool).mockClear();
    const tasks = new TaskManager();
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "r1", name: "fs_read", input: { path: "C:/Users/anton/Desktop/план.txt" } }, SEND] },
      { text: "Отправил." },
    ]);
    const sendAction = vi.fn((cmd: ActionCommand) => {
      if (cmd.kind === "fs.read") tasks.cancelUser("u1"); // владелец сказал «отмени», пока читался файл
      return Promise.resolve({ commandId: "c", ok: true, durationMs: 1, data: { content: "план" } });
    });
    const { session, deps } = base(llm, tasks, sendAction);
    await handleUserText(session, "прочитай план и напиши Кате", deps);
    expect(called("fs_read")).toBe(true);
    expect(called("telegram_send")).toBe(false);
    expect(tasks.list("u1")[0]?.state).toBe("cancelled");
  });
});
