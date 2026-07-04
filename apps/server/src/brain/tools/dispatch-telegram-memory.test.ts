import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { ResolutionMemory } from "../../memory/resolution-memory.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;

function ctx(userId: string, sendAction: Send, mem: ResolutionMemory): ToolContext {
  return {
    session: { sendAction },
    userId,
    confirm: async () => ({ approved: true }), // авто-подтверждение гейта §14 для теста
    resolutionMemory: mem,
  } as unknown as ToolContext;
}

// Опытная память резолва (§ скорость): recall → hint в команде; ВЕРИФИЦИРОВАННЫЙ успех → remember;
// resolve-ошибка по запомненному → forget (self-heal). Память = гипотеза, доставка = страж.
describe("telegram_send × опытная память", () => {
  it("recall передаёт preferredTitle/hintPeerId в команду; успех → remember(peerId,title)", async () => {
    const mem = new ResolutionMemory(() => 1);
    mem.remember("mem-u1", "telegram", "Герман", { peerId: "8509637953", title: "Herman" }); // hits=1
    let sent: ActionCommand | undefined;
    const sendAction = vi.fn<Send>(async (cmd) => {
      sent = cmd;
      return { commandId: "c", ok: true, data: { chatTitle: "Herman", peerId: "8509637953" }, durationMs: 1 };
    });
    const r = await dispatchTool("telegram_send", { to: "Герман", text: "привет" }, ctx("mem-u1", sendAction, mem));
    expect(r.isError).toBe(false);
    expect(sent && (sent as { preferredTitle?: string }).preferredTitle).toBe("Herman"); // fast-path hint
    expect(sent && (sent as { hintPeerId?: string }).hintPeerId).toBe("8509637953");
    expect(String(r.content)).toContain("Herman"); // называем реального адресата
    expect(mem.recall("mem-u1", "telegram", "Герман")?.hits).toBe(2); // успех обновил память
  });

  it("resolve-ошибка по запомненному → forget (устаревший резолв вычищен)", async () => {
    const mem = new ResolutionMemory(() => 1);
    mem.remember("mem-u2", "telegram", "Герман", { peerId: "8509637953", title: "Herman" });
    const sendAction = vi.fn<Send>(async () => ({
      commandId: "c",
      ok: false,
      error: { code: "runtime", message: "[tg-resolve] не нашёл контакт «Герман»" },
      durationMs: 1,
    }));
    const r = await dispatchTool("telegram_send", { to: "Герман", text: "привет" }, ctx("mem-u2", sendAction, mem));
    expect(r.isError).toBe(true);
    expect(String(r.content)).not.toContain("[tg-resolve]"); // маркер снят перед моделью
    expect(mem.recall("mem-u2", "telegram", "Герман")).toBeUndefined(); // self-heal
  });

  it("без памяти в ctx — отправка работает как раньше (обратная совместимость)", async () => {
    const mem = new ResolutionMemory(() => 1);
    const sendAction = vi.fn<Send>(async () => ({ commandId: "c", ok: true, data: { chatTitle: "Катя", peerId: "1882429334" }, durationMs: 1 }));
    const noMemCtx = { session: { sendAction }, userId: "mem-u3", confirm: async () => ({ approved: true }) } as unknown as ToolContext;
    const r = await dispatchTool("telegram_send", { to: "Катя", text: "хей" }, noMemCtx);
    expect(r.isError).toBe(false);
    // память не задана — просто запомнить негде, без падения
    expect(mem.recall("mem-u3", "telegram", "Катя")).toBeUndefined();
  });
});
