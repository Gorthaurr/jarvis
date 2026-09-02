/**
 * 🔴 ЖИВОЙ ЭПИЗОД 2026-09-01: владелец спросил «какие у тебя слабости», модель вызвала
 * `tool_load{names:["self_weaknesses"]}` ТРИ раза подряд и честно доложила «инструмент так и не
 * поднялся». Причина: набор инструментов собирался ОДИН раз перед циклом, поэтому подгруженный
 * холодный инструмент в этой же задаче не появлялся. На основном канале дефект маскировал фолбэк
 * dispatch (исполняет по имени и без схемы), а в резерве на подписке набор — единственный источник
 * доступного: чего в нём нет, того не вызвать.
 *
 * Тест против РЕАЛЬНОЙ петли, а не чистой функции — по тому же уроку, что и gate-declined-loop:
 * дефект жил ровно в проводке между механизмами, и все юнит-тесты его не видели.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand } from "@jarvis/protocol";
import { COLD_TOOL_NAMES } from "@jarvis/tools";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

function session() {
  return {
    sessionId: "s1",
    userId: "u1",
    sendAction: vi.fn((_cmd: ActionCommand) => Promise.resolve({ commandId: "c", ok: true, durationMs: 1 })),
    send: vi.fn(),
  } as unknown as Session;
}

function deps(llm: MockLlmProvider, toolActivation: Set<string>): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: "u1",
    tasks: new TaskManager(),
    toolActivation,
  } as AgentDeps;
}

/** Имена инструментов, отправленных модели в N-м запросе. */
const toolNames = (llm: MockLlmProvider, i: number): string[] => (llm.requests[i]?.tools ?? []).map((t) => t.name);

describe("tool_load: подгруженный инструмент доступен СРАЗУ, в этой же задаче", () => {
  it("после успешного tool_load схема появляется в наборе следующего шага", async () => {
    expect(COLD_TOOL_NAMES.has("self_weaknesses")).toBe(true); // предпосылка: он действительно холодный
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "tool_load", input: { names: ["self_weaknesses"] } }] },
      { text: "Слабостей в логах не нашёл, сэр." },
    ]);
    const activation = new Set<string>();

    await handleUserText(session(), "посмотри свою телеметрию и скажи, что у тебя ломается", deps(llm, activation));

    expect(toolNames(llm, 0)).not.toContain("self_weaknesses"); // до подгрузки — только каталогом
    expect(toolNames(llm, 1)).toContain("self_weaknesses"); // ← до фикса здесь его НЕ БЫЛО
    expect(activation.has("self_weaknesses")).toBe(true);
  });

  it("каталог холодных перестаёт предлагать уже подгруженный инструмент", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "t1", name: "tool_load", input: { names: ["self_weaknesses"] } }] },
      { text: "Готово." },
    ]);
    await handleUserText(session(), "глянь свои слабости", deps(llm, new Set<string>()));
    const catalogBefore = String(llm.requests[0]?.systemTools ?? "");
    const catalogAfter = String(llm.requests[1]?.systemTools ?? "");
    expect(catalogBefore).toContain("self_weaknesses");
    expect(catalogAfter).not.toContain("self_weaknesses"); // иначе модель грузит его снова и снова
  });

  it("каталог обещает доступность со следующего ШАГА (декларация совпадает с поведением)", async () => {
    const llm = new MockLlmProvider([{ text: "Слушаю, сэр." }]);
    await handleUserText(session(), "привет", deps(llm, new Set<string>()));
    const catalog = String(llm.requests[0]?.systemTools ?? "");
    if (catalog) expect(catalog).toMatch(/СЛЕДУЮЩЕГО ШАГА/i);
  });
});
