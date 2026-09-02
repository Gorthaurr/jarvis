/**
 * Причина №1 из USER_SCENARIOS_2026-09-02: tier0 «открой/запусти X» с неизвестным именем умирал честным
 * «не нашёл» БЕЗ отката в модель — «запусти тесты»-класс не работал вовсе. Проверяем ПЕТЛЁЙ:
 * app.launch → not_found → модель получает ход; прочие коды ошибок (timeout) — прежний терминал без модели.
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

function session(code: "not_found" | "timeout") {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "app.launch"
        ? { commandId: "c", ok: false, error: { code, message: code === "not_found" ? "не нашёл" : "превышен таймаут" }, durationMs: 1 }
        : { commandId: "c", ok: true, durationMs: 1 },
    ),
  );
  return { session: { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session, sendAction };
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

describe("tier0 app.launch не нашёл цель → ход уходит модели (не терминал «не нашёл»)", () => {
  it("«открой тикетов» (tier0 app.launch) + not_found → модель вызвана, реплика — от модели", async () => {
    const { session: s, sendAction } = session("not_found");
    const llm = new MockLlmProvider([{ text: "Такого приложения нет, сэр — открыл бы через поиск, если уточните." }]);
    const reply = await handleUserText(s, "открой тикетов", deps(llm));
    expect(sendAction).toHaveBeenCalledTimes(1); // tier0 попробовал
    expect(llm.requests.length).toBeGreaterThanOrEqual(1); // …и передал модели
    expect(reply.voice).toContain("Такого приложения нет");
    expect(reply.voice).not.toMatch(/не нашёл/u);
  });

  it("другой код провала (timeout) → прежний честный терминал БЕЗ модели", async () => {
    const { session: s } = session("timeout");
    const llm = new MockLlmProvider([{ text: "модель не должна вызываться" }]);
    const reply = await handleUserText(s, "открой тикетов", deps(llm));
    expect(llm.requests).toHaveLength(0);
    expect(reply.voice).toMatch(/тикетов/u);
    expect(reply.voice).toMatch(/не дождался/u);
  });
});
