/**
 * W4 «Руки»: фасады look/window/audio в ПЕТЛЕ (проводка — handleUserText, не чистая функция).
 *  - look{what:"elements"} уходит клиенту как ui.snapshot и, вернув элементы, снимает verify-долг после act failed;
 *  - window{op:"focus", query} уходит как window.focus с query (аренда ввода — по каноническому имени);
 *  - audio{op:"set"} → audio.set; look с неизвестным what → честная ошибка инструмента;
 *  - объект tool_use от провайдера НЕ мутируется (канал подписки сопоставляет по нему хендлер).
 * Реверт-проверка: замени `canonicalUse(raw)` на `raw` в tool-round — первые три кейса падают.
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

function session() {
  const sendAction = vi.fn((cmd: ActionCommand) =>
    Promise.resolve(
      cmd.kind === "ui.snapshot"
        ? { commandId: "c", ok: true, data: { window: "W", pid: 1, items: [{ handle: 1, role: "Button", name: "Отправлено" }], truncated: false }, durationMs: 1 }
        : cmd.kind === "gui.act"
          ? { commandId: "c", ok: true, data: { did: "UIA invoke", verified: "failed", detail: "признак не наступил" }, durationMs: 1 }
          : cmd.kind === "window.focus"
            ? { commandId: "c", ok: true, data: { focused: true, hwnd: 5, title: "Блокнот" }, durationMs: 1 }
            : cmd.kind === "audio.set"
              ? { commandId: "c", ok: true, data: { touched: 1, sessions: [{ pid: 3, process: "chrome", muted: true, volume: 1 }] }, durationMs: 1 }
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
const kinds = (s: Session): string[] => (s.sendAction as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as ActionCommand).kind);

describe("фасады в петле", () => {
  it("look{what:'elements'} → ui.snapshot клиенту; элементы вернулись → verify-долг после act failed снят", async () => {
    const tu = { id: "l1", name: "look", input: { what: "elements", maxItems: 100 } };
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "a1", name: "act", input: { target: "Отправить", verify: { text: "Отправлено" } } }] },
      { toolUses: [tu] },
      { text: "Готово, сэр — отправлено." },
      { text: "Готово, сэр — отправлено." },
    ]);
    const s = session();
    await handleUserText(s, "отправь сообщение", deps(llm));
    const snap = (s.sendAction as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ActionCommand).find((c) => c.kind === "ui.snapshot");
    expect(snap).toMatchObject({ kind: "ui.snapshot", maxItems: 100 });
    expect(verifyNudged(llm)).toBe(false);
    expect(tu).toEqual({ id: "l1", name: "look", input: { what: "elements", maxItems: 100 } }); // объект SDK не тронут
  });

  it("window{op:'focus', query} → window.focus; audio{op:'set'} → audio.set", async () => {
    const llm = new MockLlmProvider([
      { toolUses: [{ id: "w1", name: "window", input: { op: "focus", query: "Блокнот" } }] },
      { toolUses: [{ id: "s1", name: "audio", input: { op: "set", process: "chrome", mute: true } }] },
      { text: "Сделано, сэр." },
    ]);
    const s = session();
    await handleUserText(s, "выведи блокнот и заглуши хром", deps(llm));
    const cmds = (s.sendAction as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ActionCommand);
    expect(cmds.find((c) => c.kind === "window.focus")).toMatchObject({ kind: "window.focus", query: "Блокнот" });
    expect(cmds.find((c) => c.kind === "audio.set")).toMatchObject({ kind: "audio.set", process: "chrome", mute: true });
    expect(kinds(s)).not.toContain("window.arrange");
  });

  it("look с неизвестным what → честная ошибка инструмента, клиенту ничего не уходит", async () => {
    const llm = new MockLlmProvider([{ toolUses: [{ id: "l1", name: "look", input: { what: "everything" } }] }, { text: "Не вышло, сэр." }]);
    const s = session();
    await handleUserText(s, "посмотри всё", deps(llm));
    expect(kinds(s)).toEqual([]);
    const res = JSON.stringify(llm.requests[1]?.messages ?? "");
    expect(res).toMatch(/Неизвестный инструмент: look/u);
  });
});
