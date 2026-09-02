/**
 * ЖИВЫЕ ДЕФЕКТЫ СКВОЗНЫХ СЦЕНАРИЕВ (2026-09-02) — закрыты ПОВЕДЕНИЕМ, а не грепом.
 *
 * Что проверяем (каждый пункт падает, если снять соответствующий фикс):
 *  1) self_*-инструменты (телеметрия и исходники МАШИНЫ ВЛАДЕЛЬЦА) в продуктовом режиме недоступны —
 *     живьём второму пользователю доложили статистику сбоев по ВСЕМУ серверу и предложили «почини себя».
 *     Реверт: убери гейт `ctx.productMode && SELF_TOOLS.has(name)` в dispatch.ts — упадёт.
 *  2) Разговорный ход (вопрос) не получает ack «Занимаюсь, сэр» — карта проекта обещает «вопрос ≠ задача».
 *     Реверт: верни условие ack без `!isConversational` — упадёт.
 *  3) Аварийный стоп администратора называется своей причиной, а не «достигнут лимит» (иначе человек
 *     пойдёт покупать кредиты вместо разговора с администратором).
 *     Реверт: убери ветку `limitedReason === "kill_switch"` — упадёт.

 * (Стоимость по подписке для /cogs проверяется типами и живым прогоном: мок LLM всегда отдаёт stubbed,
 * то есть до платной ветки не доходит — декоративный тест здесь заводить нельзя.)
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { SpendGuard } from "../billing/index.js";
import { type AgentDeps, handleUserText } from "../brain/agent/index.js";
import { TaskManager } from "../brain/tasks/manager.js";
import { dispatchTool } from "../brain/tools/dispatch.js";
import type { Session } from "../gateway/session.js";
import { MockLlmProvider } from "../integrations/llm.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { MockWebProvider } from "../integrations/web.js";
import { InMemoryEpisodicMemory } from "../memory/episodic.js";
import { WorkingMemory } from "../memory/working.js";

function session(): Session {
  const sendAction = vi.fn((_cmd: ActionCommand, _t?: number) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 }));
  return { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session;
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
    ...over,
  };
}

const toolCtx = (productMode: boolean) =>
  ({
    session: { sendAction: vi.fn(() => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 })) },
    web: new MockWebProvider(),
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    userId: "u1",
    productMode,
  }) as never;

describe("продуктовые гейты — поведением", () => {
  it("self_* в продуктовом режиме отказывают честно; у владельца (флаг 0) работают", async () => {
    for (const name of ["self_weaknesses", "self_code_search", "self_code_read", "self_patch"]) {
      const denied = await dispatchTool(name, { query: "quota", stage: "begin" }, toolCtx(true));
      expect(denied.isError, `${name} обязан отказать арендатору`).toBe(true);
      expect(String(denied.content)).toMatch(/владельц/iu);
    }
    // Флаг 0 — путь владельца цел: инструмент реально исполняется (не отказ гейта).
    const owner = await dispatchTool("self_code_search", { query: "resolveTierModels" }, toolCtx(false));
    expect(String(owner.content)).not.toMatch(/облачном режиме/iu);
  });

  it("вопрос не получает ack «Занимаюсь, сэр» (вопрос ≠ задача)", async () => {
    const spoken: string[] = [];
    const llm = new MockLlmProvider([{ text: "Четыре, сэр." }]);
    const reply = await handleUserText(session(), "сколько будет два плюс два", deps(llm, {
      speakResult: (r: { voice?: string }) => {
        if (r.voice) spoken.push(r.voice);
      },
    } as Partial<AgentDeps>));
    expect(JSON.stringify(reply)).toContain("Четыре");
    expect(spoken.join(" ")).not.toMatch(/Занимаюсь/u);
  });

  it("аварийный стоп администратора назван своей причиной, а не «лимитом»", async () => {
    const guard = new SpendGuard();
    guard.engageKillSwitch();
    const llm = new MockLlmProvider([{ text: "не должно дойти" }]);
    const reply = await handleUserText(session(), "составь отчёт по рынку и пришли файл", deps(llm, { spend: guard, quotaExhaustedText: "Кредиты тарифа исчерпаны, сэр." }));
    const said = JSON.stringify(reply);
    expect(said).toMatch(/администратор/iu);
    expect(said).not.toMatch(/лимит на задачу/iu);
    expect(said).not.toMatch(/Кредиты тарифа исчерпаны/u); // это ДРУГАЯ причина — путать нельзя
  });

});
