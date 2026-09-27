/**
 * W3 (L-8, текст нуджа): после слепого web_act (НЕВИДИМЫЙ браузер Джарвиса) verify-нудж зовёт глаза ТОГО ЖЕ
 * браузера — web_read / web_inspect, — а не browser_read/browser_inspect (вкладки владельца в его Chrome: сверка
 * там видела бы чужую страницу). Остальные руки получают прежнюю лестницу дословно (контракт волны).
 * ПЕТЛЁЙ: handleUserText + настоящий dispatchTool (web_act/act уходят в поддельный клиент).
 * Реверт-проверка (из копии): `web = false` в verify-hint.ts — падает первый кейс; `lastBlindHand` без пропуска
 * «(ошибка)» — третий.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider, type MockTurn } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { TaskManager } from "../tasks/manager.js";
import { type AgentDeps, handleUserText } from "./index.js";

/** Клиент: всё проходит ok; клик act — без собственной сверки (unchecked), один web_act может упасть. */
function session(opts: { failWebActOnce?: boolean } = {}) {
  let failNext = opts.failWebActOnce === true;
  const sendAction = vi.fn(async (cmd: ActionCommand): Promise<ActionResult> => {
    if (cmd.kind === "gui.act") return { commandId: "c", ok: true, durationMs: 1, data: { found: { via: "snapshot", name: "Далее" }, did: "UIA invoke", verified: "unchecked", detail: "…" } };
    if (cmd.kind === "jbrowser.act" && failNext) {
      failNext = false;
      return { commandId: "c", ok: false, durationMs: 1, error: "элемент не найден" };
    }
    return { commandId: "c", ok: true, durationMs: 1, data: { text: "страница" } };
  });
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

/** Текст первого verify-нуджа, как он ушёл модели (снимок истории на момент вызова), или null. */
function spyNudge(llm: MockLlmProvider): () => string | null {
  const seen: string[] = [];
  const orig = llm.complete.bind(llm);
  llm.complete = async (req) => {
    seen.push(JSON.stringify(req.messages));
    return orig(req);
  };
  return () => {
    const m = seen.find((s) => s.includes("лестница §Волна3"));
    if (!m) return null;
    const i = m.indexOf("лестница §Волна3");
    return m.slice(i - 400, i + 700);
  };
}

const CLAIM = "Готово, сэр — нажал «Далее».";
const claims = (): MockTurn[] => [{ text: CLAIM }, { text: CLAIM }, { text: CLAIM }];
const WEB_ACT = { id: "w1", name: "web_act", input: { intent: "click", params: { text: "Далее" } } };

describe("W3 L-8: verify-нудж после web_act — глаза невидимого браузера", () => {
  it("web_act → «Готово»: нудж называет web_read/web_inspect и НЕ зовёт browser_read/browser_inspect", async () => {
    const llm = new MockLlmProvider([{ toolUses: [WEB_ACT] }, ...claims()]);
    const nudge = spyNudge(llm);
    await handleUserText(session(), "нажми кнопку далее на странице в фоновом браузере", deps(llm));
    const text = nudge();
    expect(text).not.toBeNull();
    expect(text).toMatch(/НЕ проверил исход|СВЕРЬ/u); // начало общего текста — как было (контракт)
    expect(text).toMatch(/web_read/u);
    expect(text).toMatch(/web_inspect/u);
    expect(text).not.toMatch(/browser_read|browser_inspect/u);
  });

  it("клик в окне (act без сверки) — прежняя лестница дословно, с browser_read", async () => {
    const llm = new MockLlmProvider([{ toolUses: [{ id: "a1", name: "act", input: { target: "Далее" } }] }, ...claims()]);
    const nudge = spyNudge(llm);
    await handleUserText(session(), "нажми кнопку далее в окне установщика", deps(llm));
    expect(nudge()).toMatch(/look\{what:'elements'\} \(нативное окно\) \/ browser_read \/ browser_inspect \(веб\)/u);
  });

  it("упавший web_act, затем удачный клик в окне (act) — лестница по руке, что РЕАЛЬНО оставила долг", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "a1", name: "act", input: { target: "Далее" } }] },
      { toolUses: [WEB_ACT] },
      ...claims(),
    ]);
    const nudge = spyNudge(llm);
    await handleUserText(session({ failWebActOnce: true }), "нажми кнопку далее в окне установщика", deps(llm));
    const text = nudge();
    expect(text).toMatch(/browser_read/u); // упавший web_act долга не взвёл — сверять надо окно после act
    expect(text).not.toMatch(/web_inspect/u);
  });
});
