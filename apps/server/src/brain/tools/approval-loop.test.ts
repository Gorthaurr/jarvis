/**
 * W2 П3 — проводка «рубеж клиента → вопрос владельцу → повтор с грантом» ПЕТЛЁЙ (`handleUserText`, правило проекта):
 * вопрос идёт настоящим путём ToolContext.confirm → Session.requestConfirm, а честный исход (uncertain после
 * частичной инжекции) доходит до журнала прерванной задачи как «ИСХОД НЕИЗВЕСТЕН», а не «ОШИБКА = не сделано».
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { CheckpointStore } from "../agent/checkpoint-store.js";
import { type AgentDeps, handleUserText } from "../agent/index.js";
import { TaskManager } from "../tasks/manager.js";

/** Клиент: gui.act без гранта → denied + needsApproval (реальная форма); injected — часть действия уже ушла. */
function session(injected: boolean) {
  const sendAction = vi.fn(async (cmd: ActionCommand): Promise<ActionResult> => {
    if (cmd.kind !== "gui.act") return { commandId: "c", ok: true, durationMs: 1 };
    const grant = cmd.approval?.grants.find((g) => g.signature === "key:enter" && g.process === "telegram" && g.hwnd === 31);
    if (grant) return { commandId: "c", ok: true, durationMs: 1, data: { did: "type+enter", verified: "unchecked" } };
    return {
      commandId: "c",
      ok: false,
      durationMs: 1,
      error: { code: "denied", message: "нужно одобрение" },
      data: { needsApproval: { category: "messenger", process: "telegram", hwnd: 31, windowTitle: "Катя", what: "Enter", signature: "key:enter", pendingText: "привет" } },
      ...(injected ? { stepActionInjected: true } : {}),
    };
  });
  const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }));
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm } as unknown as Session & { sendAction: typeof sendAction; requestConfirm: typeof requestConfirm };
}

function deps(llm: MockLlmProvider, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    userContext: { systemContext: "Окна: 2 · На переднем плане: explorer «Проводник»" },
    ...over,
  } as AgentDeps;
}

const ACT = { id: "a1", name: "act", input: { app: "Катя", do: "type", target: "Сообщение", text: "привет", enter: true } };

describe("needsApproval петлёй: вопрос через Session.requestConfirm → повтор с грантом", () => {
  it("app «Катя» (процесс неизвестен заранее) → клиент спросил → владелец «да» → второй gui.act с грантом и hwnd", async () => {
    const s = session(false);
    const llm = new MockLlmProvider([{ toolUses: [ACT] }, { text: "Отправил, сэр." }]);
    await handleUserText(s, "напиши Кате привет", deps(llm));
    expect(s.requestConfirm).toHaveBeenCalledTimes(1);
    expect(String(s.requestConfirm.mock.calls[0]![0].summary)).toMatch(/программе telegram \(мессенджер\): Enter — отправка сообщения/u);
    const acts = s.sendAction.mock.calls.map((c) => c[0]).filter((c) => c.kind === "gui.act");
    expect(acts).toHaveLength(2);
    expect(acts[1]!.approval?.grants).toEqual([{ signature: "key:enter", process: "telegram", hwnd: 31, count: 1 }]);
  });
});

describe("injected → uncertain доходит до журнала петлёй", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-p3-cp-"));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
  });
  afterEach(() => {
    delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
    delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
    rmSync(dir, { recursive: true, force: true });
  });

  it("набрал, но Enter упёрся в рубеж → без вопроса и повтора; журнал: «ИСХОД НЕИЗВЕСТЕН», не «ОШИБКА»", async () => {
    const s = session(true);
    const checkpoints = new CheckpointStore(dir);
    const llm = new MockLlmProvider([
      { toolUses: [ACT] },
      { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    await handleUserText(s, "напиши Кате привет", deps(llm, { checkpoints }));
    expect(s.requestConfirm).not.toHaveBeenCalled();
    expect(s.sendAction.mock.calls.filter((c) => c[0].kind === "gui.act")).toHaveLength(1);
    const digest = checkpoints.peek("u1")?.digest ?? "";
    expect(digest).toMatch(/act\(.*\) — ИСХОД НЕИЗВЕСТЕН/u);
  });
});
