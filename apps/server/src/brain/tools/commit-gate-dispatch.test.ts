/**
 * §14 гейт необратимых кликов — ПРОВОДКА через реальный dispatchTool (причина №4 USER_SCENARIOS_2026-09-02):
 * browser_act «Опубликовать» на YouTube Studio и Enter в WhatsApp спрашивают владельца; отказ → declined и
 * действие не уходит в расширение; нейтральные клики не спрашивают. GUI: ui_invoke «Провести» при 1С на
 * переднем плане и Enter в Telegram Desktop — тоже через подтверждение; web_act по цели web_open — тоже.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
const okSend: Send = async () => ({ commandId: "c", ok: true, durationMs: 1 });

function makeCtx(over: Partial<ToolContext> & { approved?: boolean; foreground?: string }): ToolContext & { confirm: ReturnType<typeof vi.fn> } {
  const { approved = true, foreground, ...rest } = over;
  const confirm = vi.fn(async () => ({ approved, outcome: approved ? "approved" : "denied" }));
  return {
    session: { sendAction: okSend },
    userId: "u1",
    confirm,
    systemContext: () => (foreground ? `Окна: 3 · На переднем плане: ${foreground} «Окно» · Пользователь: за ПК` : ""),
    ...rest,
  } as unknown as ToolContext & { confirm: ReturnType<typeof vi.fn> };
}
function ext(tabAct = vi.fn(async () => ({ ok: true, changed: true }))) {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 5 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: "", title: "", count: 0, elements: [] })),
    tabAct,
    tabList: vi.fn(async () => ({ tabs: [], count: 0 })),
    tabClose: vi.fn(async () => ({ closed: 1 })),
    exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
  };
}

describe("browser_act — необратимый клик/Enter на опасном хосте", () => {
  it("«Опубликовать» на studio.youtube.com: спрашивает; отказ → declined, tabAct НЕ вызван", async () => {
    const tabAct = vi.fn(async () => ({ ok: true }));
    const c = makeCtx({ ext: ext(tabAct), approved: false });
    const r = await dispatchTool("browser_act", { url: "https://studio.youtube.com/video/x/edit", intent: "click", params: { text: "Опубликовать" } }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(String(c.confirm.mock.calls[0]?.[0])).toMatch(/Опубликовать/u);
    expect(r.declined).toBe(true);
    expect(tabAct).not.toHaveBeenCalled();
  });

  it("одобрение → действие уходит в расширение", async () => {
    const tabAct = vi.fn(async () => ({ ok: true, changed: true }));
    const c = makeCtx({ ext: ext(tabAct), approved: true });
    const r = await dispatchTool("browser_act", { url: "https://studio.youtube.com/", intent: "click", params: { text: "Опубликовать" } }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(tabAct).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(false);
  });

  it("Enter в web.whatsapp.com (type+enter) — спрашивает; нейтральный клик на youtube — нет", async () => {
    const c = makeCtx({ ext: ext() });
    await dispatchTool("browser_act", { url: "https://web.whatsapp.com/", intent: "type", params: { text: "привет", enter: true } }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    const c2 = makeCtx({ ext: ext() });
    await dispatchTool("browser_act", { url: "https://www.youtube.com/", intent: "click", params: { text: "Смотреть позже" } }, c2);
    expect(c2.confirm).not.toHaveBeenCalled();
  });

  it("нет канала подтверждения → честная ошибка, действие не уходит", async () => {
    const tabAct = vi.fn(async () => ({ ok: true }));
    const c = makeCtx({ ext: ext(tabAct) });
    (c as unknown as { confirm?: unknown }).confirm = undefined;
    const r = await dispatchTool("browser_act", { url: "https://www.ozon.ru/cart", intent: "click", params: { text: "Оплатить" } }, c);
    expect(r.isError).toBe(true);
    expect(tabAct).not.toHaveBeenCalled();
  });
});

describe("GUI — коммит в опасном процессе на переднем плане", () => {
  it("input_key Enter при Telegram на переднем плане — спрашивает; в notepad — нет", async () => {
    const sendAction = vi.fn<Send>(okSend);
    const c = makeCtx({ session: { sendAction } as unknown as ToolContext["session"], foreground: "Telegram", approved: false });
    const r = await dispatchTool("input_key", { key: "enter" }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    expect(sendAction).not.toHaveBeenCalled();
    const c2 = makeCtx({ session: { sendAction } as unknown as ToolContext["session"], foreground: "notepad" });
    await dispatchTool("input_key", { key: "enter" }, c2);
    expect(c2.confirm).not.toHaveBeenCalled();
    expect(sendAction).toHaveBeenCalledTimes(1);
  });

  it("ui_invoke по handle «Провести» при 1cv8: подпись берётся из последнего ui_snapshot → спрашивает", async () => {
    const sendAction = vi.fn<Send>(async (cmd) =>
      cmd.kind === "ui.snapshot"
        ? { commandId: "c", ok: true, data: { items: [{ handle: 41, role: "Button", name: "Провести и закрыть" }, { handle: 42, role: "Button", name: "Печать" }] }, durationMs: 1 }
        : { commandId: "c", ok: true, durationMs: 1 },
    );
    const session = { sendAction } as unknown as ToolContext["session"];
    const c = makeCtx({ session, foreground: "1cv8", approved: true });
    await dispatchTool("ui_snapshot", {}, c);
    await dispatchTool("ui_invoke", { handle: 42 }, c); // «Печать» — не коммит
    expect(c.confirm).not.toHaveBeenCalled();
    await dispatchTool("ui_invoke", { handle: 41 }, c); // «Провести и закрыть» — коммит
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(String(c.confirm.mock.calls[0]?.[0])).toMatch(/Провести/u);
  });
});

describe("web_act (невидимый браузер) — по последней цели web_open", () => {
  it("web_open ozon → web_act click «Оплатить» спрашивает; на нейтральном сайте — нет", async () => {
    const sendAction = vi.fn<Send>(okSend);
    const c = makeCtx({ session: { sendAction } as unknown as ToolContext["session"], approved: false });
    await dispatchTool("web_open", { url: "https://www.ozon.ru/cart" }, c);
    const r = await dispatchTool("web_act", { intent: "click", params: { text: "Оплатить" } }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    const c2 = makeCtx({ session: { sendAction } as unknown as ToolContext["session"] });
    await dispatchTool("web_open", { url: "https://docs.example.com/" }, c2);
    await dispatchTool("web_act", { intent: "click", params: { text: "Оплатить" } }, c2);
    expect(c2.confirm).not.toHaveBeenCalled();
  });
});
