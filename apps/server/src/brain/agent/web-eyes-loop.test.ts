/**
 * W3 (L-8): web_inspect — глаз невидимого браузера Джарвиса. После слепого web_act модель смотрит на страницу тем же
 * браузером (web_inspect: элементы и их состояние), и этот взгляд снимает долг сверки, как browser_inspect у вкладок
 * владельца. Раньше web_inspect числился mutate: сверка им не засчитывалась, и «Готово» после честного взгляда
 * получало verify-нудж, толкавший в browser_read — в ЧУЖОЙ браузер (Chrome владельца).
 * Петлёй: handleUserText + MockLlm + настоящий dispatchTool. Реверт: убери web_inspect из VERIFY_TOOLS (error-voice.ts)
 * — первый тест упадёт; второй — самопроверка стенда (без взгляда нудж ОБЯЗАН прийти).
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

const URL = "https://example.org/catalog";

function session() {
  const kinds: string[] = [];
  const sendAction = vi.fn(async (cmd: ActionCommand) => {
    kinds.push(cmd.kind);
    if (cmd.kind === "jbrowser.inspect") {
      return { commandId: "c", ok: true, data: { url: URL, elements: [{ ref: "e7", role: "button", name: "Показать ещё", state: "disabled" }, { ref: "e8", text: "Показано 40 из 40" }] }, durationMs: 1 };
    }
    return { commandId: "c", ok: true, data: { url: URL, did: "click" }, durationMs: 1 };
  });
  return { s: { sessionId: "s1", userId: "u1", sendAction, send: vi.fn(), requestConfirm: vi.fn() } as unknown as Session, kinds };
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

const NUDGE = /НЕ проверил исход|НЕ сверил его глазами/u;
const nudged = (llm: MockLlmProvider): boolean => llm.requests.some((r) => NUDGE.test(JSON.stringify(r.messages)));
const ACT = { id: "a1", name: "web_act", input: { intent: "click", params: { text: "Показать ещё" } } };
const TEXT = "нажми на странице каталога показать ещё, пока не кончится список";

describe("web_inspect снимает долг сверки после web_act (L-8)", () => {
  it("web_act → web_inspect → «Готово» — без verify-нуджа", async () => {
    const { s, kinds } = session();
    const llm = new MockLlmProvider([
      { toolUses: [ACT] },
      { toolUses: [{ id: "i1", name: "web_inspect", input: { query: "Показать ещё" } }] },
      { text: "Готово, сэр — показаны все 40." },
      { text: "Готово, сэр — показаны все 40." },
    ]);
    const reply = await handleUserText(s, TEXT, deps(llm));
    expect(kinds).toContain("jbrowser.inspect"); // взгляд реально ушёл в невидимый браузер
    expect(nudged(llm)).toBe(false); // до фикса: web_inspect = mutate, долг висел → «сверь browser_read» в чужой браузер
    expect(reply.voice).toMatch(/все (?:40|сорок)/u);
  });

  it("самопроверка стенда: web_act → «Готово» без взгляда — нудж приходит", async () => {
    const llm = new MockLlmProvider([{ toolUses: [ACT] }, { text: "Готово, сэр." }, { text: "Готово, сэр." }, { text: "Готово, сэр." }]);
    await handleUserText(session().s, TEXT, deps(llm));
    expect(nudged(llm)).toBe(true);
  });
});
