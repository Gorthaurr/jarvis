/**
 * Интеграция W2 (п.5): отказ рубежа БЕЗ вопроса владельцу (§0, своё окно), пришедший ПОСЛЕ ушедшей части действия
 * (`stepActionInjected`: кусок печати, клик в поле), — «исход неизвестен», а не «не сделано». Проводка — ПЕТЛЁЙ:
 * настоящий `handleUserText` → dispatchTool → журнал чекпойнта (`CheckpointStore`); подменён только клиент.
 *
 * 🔴 ДЕФЕКТ. Клиент: «привет» ушло, дальше §0 (фокус сам встал в поле пароля) → `denied` + stepActionInjected, без
 * needsApproval. Сервер отдавал это generic-веткой «Действие input.type не удалось: denied» — журнал писал «ОШИБКА»,
 * и «доделай» печатал текст второй раз. Реверт: убери injectedFailure из dispatch.ts / handlers/act.ts — кейсы падают.
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
import { TaskManager } from "../tasks/manager.js";
import { dispatchTool, type ToolContext } from "../tools/dispatch.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { type AgentDeps, handleUserText } from "./index.js";

/** Клиент: мутация ушла частично, дальше рубеж отказал без вопроса (форма протокола клиента W2). */
const partialDenied = (cmd: ActionCommand): ActionResult =>
  cmd.kind === "input.type" || cmd.kind === "gui.act"
    ? { commandId: "c", ok: false, durationMs: 1, error: { code: "denied", message: "§0: поле пароля/кода (фокус) — часть текста УЖЕ напечатана" }, data: { secretGuard: "field" }, stepActionInjected: true }
    : { commandId: "c", ok: true, durationMs: 1 };

function session(userId: string): Session {
  const sendAction = vi.fn((cmd: ActionCommand) => Promise.resolve(partialDenied(cmd)));
  const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }));
  return { sessionId: `s-${userId}`, userId, sendAction, send: vi.fn(), requestConfirm } as unknown as Session;
}

const WRAP_ROUND = { toolUses: [{ id: "w1", name: "web_search", input: { query: "погода" } }], usage: { inputTokens: 50_000 } };

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-gui-injected-"));
  process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
  process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
});
afterEach(() => {
  delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
  delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
  rmSync(dir, { recursive: true, force: true });
});

async function digestAfter(userId: string, first: { id: string; name: string; input: Record<string, unknown> }): Promise<string> {
  const checkpoints = new CheckpointStore(dir);
  const deps: AgentDeps = {
    memory: new WorkingMemory(),
    llm: new MockLlmProvider([{ toolUses: [first] }, WRAP_ROUND, { text: "не должно вызваться" }]),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId,
    tasks: new TaskManager(),
    checkpoints,
  };
  await handleUserText(session(userId), "напечатай привет в блокноте и посмотри погоду", deps);
  const digest = checkpoints.peek(userId)?.digest;
  expect(digest, "чекпойнт не записан").toBeTruthy();
  return digest!;
}

describe("часть действия ушла, отказ без вопроса → исход неизвестен", () => {
  it.each([
    ["input_type", { text: "привет" }],
    ["act", { target: "Текст", do: "type", text: "привет" }],
  ] as const)("%s → журнал «ИСХОД НЕИЗВЕСТЕН», не «ОШИБКА»", async (name, input) => {
    const digest = await digestAfter(`u-inj-${name}`, { id: "t1", name, input: { ...input } });
    const line = digest.split("\n").find((l) => l.includes(`${name}(`)) ?? "";
    expect(line).toContain("ИСХОД НЕИЗВЕСТЕН");
    expect(line).not.toContain("ОШИБКА");
  }, 20_000);

  it("dispatchTool: uncertain и честный текст; без stepActionInjected тот же отказ — обычная ошибка (не сделано)", async () => {
    const send = vi.fn(async (cmd: ActionCommand) => partialDenied(cmd));
    const ctx = { session: { sendAction: send }, userId: "u1", systemContext: () => "На переднем плане: Блокнот" } as unknown as ToolContext;
    const r = await dispatchTool("input_type", { text: "привет" }, ctx);
    expect(r).toMatchObject({ isError: true, uncertain: true });
    expect(String(r.content)).toMatch(/§0.*ИСХОД НЕИЗВЕСТЕН/u);
    const a = await dispatchTool("act", { target: "Текст", do: "type", text: "привет" }, ctx); // свой хендлер act — тот же исход
    expect(a).toMatchObject({ isError: true, uncertain: true });
    expect(String(a.content)).toMatch(/^act: §0.*ИСХОД НЕИЗВЕСТЕН/u);
    send.mockImplementation(async () => ({ commandId: "c", ok: false, durationMs: 1, error: { code: "denied", message: "§0: карту не ввожу" } }));
    const clean = await dispatchTool("input_type", { text: "привет" }, ctx);
    expect(clean.isError).toBe(true);
    expect(clean.uncertain).toBeUndefined();
  });
});
