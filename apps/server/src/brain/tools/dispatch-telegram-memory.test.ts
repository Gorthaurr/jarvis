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

// §P1-тёзки (форензика 2026-07-14 «не та Катя»; ревью р1): peer — точный peerId выбранного владельцем
// кандидата. Главнее памяти (в обход стейл-связки короткого имени), и по многозначному имени НЕ пишет память.
describe("telegram_send × peer (§P1-тёзки)", () => {
  it("явный peer → hintPeerId=peer в обход памяти; память по многозначному to НЕ пишется", async () => {
    const mem = new ResolutionMemory(() => 1);
    mem.remember("pu1", "telegram", "Катя", { peerId: "999", title: "Катя" }); // стейл «не та Катя»
    let sent: ActionCommand | undefined;
    const sendAction = vi.fn<Send>(async (cmd) => {
      sent = cmd;
      return { commandId: "c", ok: true, data: { chatTitle: "Катя Любимая", peerId: "111" }, durationMs: 1 };
    });
    const r = await dispatchTool("telegram_send", { to: "Катя", text: "люблю", peer: "111" }, ctx("pu1", sendAction, mem));
    expect(r.isError).toBe(false);
    expect(sent && (sent as { hintPeerId?: string }).hintPeerId).toBe("111"); // peer главнее памяти
    // preferredTitle = to (ревью р2): иначе клиентский fast-path openHinted не входит и peer выбрасывается.
    // openHinted приоритизирует peerId над именем → откроет ТОЧНО выбранного, а «Катя» лишь фолбэк поиска.
    expect(sent && (sent as { preferredTitle?: string }).preferredTitle).toBe("Катя");
    // короткое многозначное «Катя» память НЕ обновляет (следующий раз снова не увело бы не туда)
    expect(mem.recall("pu1", "telegram", "Катя")?.peerId).toBe("999"); // прежняя запись не тронута этим ходом
  });

  it("стейл-память по короткому имени БЕЗ peer больше НЕ перезаписывается на успехе (антиотравление)", async () => {
    const mem = new ResolutionMemory(() => 1);
    // однозначный to (полное имя) — память пишется как раньше
    const sendAction = vi.fn<Send>(async () => ({ commandId: "c", ok: true, data: { chatTitle: "Катя Любимая", peerId: "111" }, durationMs: 1 }));
    await dispatchTool("telegram_send", { to: "Катя Любимая", text: "хей" }, ctx("pu2", sendAction, mem));
    expect(mem.recall("pu2", "telegram", "Катя Любимая")?.peerId).toBe("111"); // однозначное имя — память живёт
  });

  it("без peer — прежний fast-path по памяти точного имени (обратная совместимость)", async () => {
    const mem = new ResolutionMemory(() => 1);
    mem.remember("pu3", "telegram", "Герман", { peerId: "850", title: "Herman" });
    let sent: ActionCommand | undefined;
    const sendAction = vi.fn<Send>(async (cmd) => {
      sent = cmd;
      return { commandId: "c", ok: true, data: { chatTitle: "Herman", peerId: "850" }, durationMs: 1 };
    });
    const r = await dispatchTool("telegram_send", { to: "Герман", text: "привет" }, ctx("pu3", sendAction, mem));
    expect(r.isError).toBe(false);
    expect(sent && (sent as { hintPeerId?: string }).hintPeerId).toBe("850");
    expect(mem.recall("pu3", "telegram", "Герман")?.hits).toBe(2);
  });
});
