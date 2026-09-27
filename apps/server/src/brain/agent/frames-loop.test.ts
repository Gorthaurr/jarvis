/**
 * W2 П5: кадры задачи ПЕТЛЁЙ (handleUserText, не чистой функцией): модель смотрит (screen_capture) и кликает act{x,y} —
 * команда клиенту несёт кадр, который модель видела; клик без кадра — честная ошибка инструмента ДО клиента, модель
 * пересняла и попала; лупа (зум) называет свой кадр, и клик по увиденному в ней уходит с ним, а кадр задачи прежний.
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
  let n = 0;
  const sendAction = vi.fn((cmd: ActionCommand) => {
    n += 1;
    if (cmd.kind === "screen.capture") {
      const zoom = cmd.rect !== undefined;
      return Promise.resolve({ commandId: "c", ok: true, durationMs: 1, data: { image: "UE5H", mediaType: "image/png", width: 1920, height: 1080, frameId: `k7q${zoom ? "z" : "f"}${n}`, ...(zoom ? { zoomOf: cmd.rect?.frame } : {}) } });
    }
    if (cmd.kind === "gui.act") return Promise.resolve({ commandId: "c", ok: true, durationMs: 1, data: { did: "клик в точку", verified: "met", detail: "видно «Поиск игры»", physical: true } });
    return Promise.resolve({ commandId: "c", ok: true, durationMs: 1 });
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
const cmds = (s: Session): ActionCommand[] => (s.sendAction as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ActionCommand);
const acts = (s: Session) => cmds(s).filter((c): c is Extract<ActionCommand, { kind: "gui.act" }> => c.kind === "gui.act");
const cap = (id: string, input: Record<string, unknown> = {}) => ({ toolUses: [{ id, name: "screen_capture", input }] });
const act = (id: string, target: Record<string, unknown>) => ({ toolUses: [{ id, name: "act", input: { target, verify: { text: "Поиск игры" } } }] });

describe("кадры задачи в петле", () => {
  it("screen_capture → act{x,y}: клиенту уходит кадр, который модель видела", async () => {
    const llm = new MockLlmProvider([cap("c1"), act("a1", { x: 960, y: 540 }), { text: "Нажал «Играть», сэр." }]);
    const s = session();
    await handleUserText(s, "нажми играть в доте", deps(llm));
    expect(acts(s)[0]?.target).toEqual({ x: 960, y: 540, frame: "k7qf1" });
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("кадр k7qf1, 1920×1080");
  });

  it("act{x,y} без взгляда → ошибка инструмента «сначала screen_capture», клиенту ничего; пересняла — попала в кадр", async () => {
    const llm = new MockLlmProvider([act("a0", { x: 10, y: 10 }), cap("c1"), act("a1", { x: 960, y: 540 }), { text: "Готово, сэр." }]);
    const s = session();
    await handleUserText(s, "нажми играть в доте", deps(llm));
    expect(cmds(s).map((c) => c.kind)).toEqual(["screen.capture", "gui.act"]); // первый act клиенту не ушёл
    expect(JSON.stringify(llm.requests[1]?.messages)).toMatch(/сначала screen_capture/u);
    expect(acts(s)[0]?.target).toMatchObject({ frame: "k7qf1" });
  });

  it("лупа: rect в кадре задачи; клик с кадром лупы — с ним; клик без frame — в кадре задачи (зум задачу не перехватил)", async () => {
    const llm = new MockLlmProvider([
      cap("c1"),
      cap("c2", { rect: { x: 800, y: 400, w: 300, h: 200 } }),
      act("a1", { x: 150, y: 90, frame: "k7qz2" }),
      act("a2", { x: 960, y: 540 }),
      { text: "Готово, сэр." },
    ]);
    const s = session();
    await handleUserText(s, "нажми мелкую кнопку", deps(llm));
    expect(cmds(s).find((c) => c.kind === "screen.capture" && c.rect)).toMatchObject({ rect: { x: 800, y: 400, w: 300, h: 200, frame: "k7qf1" } });
    const zoomText = JSON.stringify(llm.requests[2]?.messages);
    expect(zoomText).toContain("ЛУПА — свежий снимок региона из кадра k7qf1: кадр k7qz2");
    expect(acts(s).map((a) => (a.target as { frame?: string }).frame)).toEqual(["k7qz2", "k7qf1"]);
  });
});
