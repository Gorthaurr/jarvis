/**
 * W4 «Руки»: act в ПЕТЛЕ (правило аудита тестовой базы — проводку проверяем handleUserText, не чистой функцией).
 *
 *  - act с verified:"met" снимает verify-долг сам (нуджа «сверь исход» нет);
 *  - act с verified:"failed" долг НЕ снимает — петля требует сверки;
 *  - act do:type + act click «Отправить» = КОММИТ отправки: собственная сверка act долг ОТПРАВКИ не гасит
 *    (как у input_click после input_type) — нужен реальный взгляд.
 * Реверт-проверка: убери "act" из BLIND_MUTATE_TOOLS — второй кейс упадёт; убери actG.commit из commitGesture —
 * третий кейс упадёт.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

function session(verified: "met" | "failed" | "unchecked") {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "gui.act"
        ? {
            commandId: "c",
            ok: true,
            data: {
              found: { via: "snapshot", name: typeof cmd.target === "string" ? cmd.target : "x" },
              did: "UIA invoke",
              verified,
              detail: "…",
              observation: { via: "a11y", text: "+ появилось «Отправлено»", delta: true, changed: true },
            },
            durationMs: 1,
          }
        : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
}

function deps(llm: MockLlmProvider): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
  };
}

const verifyNudged = (llm: MockLlmProvider): boolean => llm.requests.some((r) => JSON.stringify(r.messages).includes("НЕ проверил исход"));

const actThenClaim = () =>
  new MockLlmProvider([
    { toolUses: [{ id: "a1", name: "act", input: { target: "Играть", verify: { text: "Поиск матча" } } }] },
    { text: "Готово, сэр — поиск запущен." },
    { text: "Готово, сэр — поиск запущен." },
    { text: "Готово, сэр — поиск запущен." },
  ]);

describe("act в петле", () => {
  it("verified:met — сверка внутри act, нуджа «сверь исход» нет", async () => {
    const llm = actThenClaim();
    await handleUserText(session("met"), "запусти поиск матча", deps(llm));
    expect(verifyNudged(llm)).toBe(false);
  });

  it("verified:failed — долг остаётся, петля требует сверки", async () => {
    const llm = actThenClaim();
    await handleUserText(session("failed"), "запусти поиск матча", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });

  it("act type → act click «Отправить» = коммит отправки: собственная сверка act долг отправки не гасит", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "act", input: { target: { text: "Сообщение", role: "Edit" }, do: "type", text: "привет" } }] },
      { toolUses: [{ id: "c1", name: "act", input: { target: "Отправить", verify: { text: "привет" } } }] },
      { text: "Отправлено, сэр." },
      { text: "Отправлено, сэр." },
      { text: "Отправлено, сэр." },
    ]);
    await handleUserText(session("met"), "напиши Кате привет в телеграме", deps(llm));
    expect(verifyNudged(llm)).toBe(true);
  });
});
