/**
 * W2 (П4): act{steps} и новые глаголы act — ПЕТЛЁЙ (`handleUserText`): сигналы честности серии доходят до журнала и
 * долга сверки, как у input_batch.
 *  1. серия встала на шаге 2 из 3 → журнал «ЧАСТИЧНО — шаги 1..1 УЖЕ ВЫПОЛНЕНЫ», а не «ОШИБКА» («доделай» не повторит шаг 1);
 *  2. серия «набор → Enter» = коммит отправки: собственная сверка шага (met) долг ОТПРАВКИ не гасит → нудж сверки;
 *  3. act hover — не дело: ни verify-нуджа, ни «мутации» (error-voice: hover/scroll нейтральны).
 * Реверт-проверка: убери ветку isActSeries в send-gesture.ts — падает 2; убери строку NEUTRAL_ACT_VERBS в
 * toolCallEffect — падает 3; убери partialSteps в act-steps-result.ts — падает 1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { type AgentDeps, handleUserText } from "./index.js";

type Act = Extract<ActionCommand, { kind: "gui.act" }>;

function session(reply: (cmd: Act) => Omit<ActionResult, "commandId" | "durationMs">) {
  const sent: ActionCommand[] = [];
  const sendAction = vi.fn((cmd: ActionCommand) => {
    sent.push(cmd);
    return Promise.resolve({ commandId: "c", durationMs: 1, ...(cmd.kind === "gui.act" ? reply(cmd) : { ok: true }) });
  });
  return { s: { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session, sent };
}

const met = { ok: true, data: { found: { via: "snapshot", name: "x" }, did: "ok", verified: "met", detail: "видно" }, } as const;

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
    ...over,
  };
}

const verifyNudged = (llm: MockLlmProvider): boolean => llm.requests.some((r) => JSON.stringify(r.messages).includes("НЕ проверил исход"));

describe("act{steps} в петле", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-act-steps-"));
    process.env.JARVIS_CONTEXT_SOFT_TOKENS = "20000";
    process.env.JARVIS_CONTEXT_HARD_TOKENS = "30000";
  });
  afterEach(() => {
    delete process.env.JARVIS_CONTEXT_SOFT_TOKENS;
    delete process.env.JARVIS_CONTEXT_HARD_TOKENS;
    rmSync(dir, { recursive: true, force: true });
  });

  it("серия встала на шаге 2 из 3 → журнал «ЧАСТИЧНО — шаги 1..1 УЖЕ ВЫПОЛНЕНЫ», а не «ОШИБКА»", async () => {
    const checkpoints = new CheckpointStore(dir);
    const steps = [{ target: "Файл" }, { target: "Поиск", do: "type", text: "отчёт" }, { do: "key", combo: "Enter" }];
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "act", input: { app: "Блокнот", steps } }] },
      { toolUses: [{ id: "w1", name: "web_search", input: { query: "x" } }], usage: { inputTokens: 50_000 } },
      { text: "не должно вызваться" },
    ]);
    const { s, sent } = session((cmd) => (cmd.do === "type" ? { ok: false, error: { code: "not_found", message: "поле не найдено" } } : met));
    await handleUserText(s, "найди отчёт в блокноте", deps(llm, { checkpoints }));
    expect(sent.filter((c) => c.kind === "gui.act")).toHaveLength(2);
    const cp = checkpoints.peek("u1");
    expect(cp?.digest).toMatch(/act\([^)]*\) — ЧАСТИЧНО — шаги 1\.\.1 УЖЕ ВЫПОЛНЕНЫ/u);
    expect(cp?.digest).not.toMatch(/act\([^)]*\) — ОШИБКА/u);
  });

  it("серия «набор → Enter» — коммит отправки: сверка шага (met) долг ОТПРАВКИ не гасит → нудж сверки исхода", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "s1", name: "act", input: { steps: [{ target: "Сообщение", do: "type", text: "привет" }, { do: "key", combo: "Ctrl+Enter", verify: { text: "привет" } }] } }] },
      { text: "Отправлено, сэр." },
      { text: "Отправлено, сэр." },
      { text: "Отправлено, сэр." },
    ]);
    const { s } = session(() => met);
    await handleUserText(s, "напиши Кате привет в дискорде", deps(llm));
    expect(verifyNudged(llm)).toBe(true); // до фикса серия читалась как одиночный «click» — и «Отправлено» уходило без взгляда
  });

  it("act hover — не дело и не слепая мутация: нуджа сверки нет", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "h1", name: "act", input: { target: "Профиль", do: "hover" } }] },
      { text: "Навёл курсор на «Профиль», сэр — подсказка открыта." },
      { text: "Навёл курсор на «Профиль», сэр — подсказка открыта." },
    ]);
    const { s } = session(() => ({ ok: true, data: { did: "навёл курсор", verified: "unchecked" } }));
    await handleUserText(s, "наведи на профиль", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
  });
});
