/**
 * Контроль-10 (telegram-ext-fallback-no-veil-gate): та же дыра, что контроль-9 закрывал у `browser_open`, осталась
 * у фолбэка `telegram_send` через расширение — `openTgTab` делает `windows.update{focused:true}` (или создаёт окно)
 * и забирает клавиатуру у окна рисования: Esc владельца уходит в Telegram, а отправка ещё и необратима.
 * Реверт-проверка: убрать проверку `ctx.veilDrawing` перед `ctx.telegramSend` → первый кейс падает.
 */
import { describe, expect, it, vi } from "vitest";
import { dispatchTool, type ToolContext } from "../dispatch.js";

function ctxWith(drawing: boolean, telegramSend: ReturnType<typeof vi.fn>): ToolContext {
  return {
    // Канал ПК мёртв (channel_down): команда физически не ушла, сверять нечего → штатный путь к фолбэку расширения.
    session: { sendAction: vi.fn(async () => ({ commandId: "c", ok: false, error: { code: "channel_down", message: "канал недоступен" }, durationMs: 1 })) },
    userId: "u1",
    telegramSend,
    veilDrawing: () => drawing,
    confirm: async () => ({ approved: true, outcome: "approved" as const, requestId: "r1" }),
  } as unknown as ToolContext;
}

describe("telegram_send: фолбэк через расширение под вуалью", () => {
  it("идёт рисование → честный отказ вуали, расширение НЕ зовём", async () => {
    const telegramSend = vi.fn(async () => ({ title: "Катя" }));
    const r = await dispatchTool("telegram_send", { to: "Катя", text: "буду через час" }, ctxWith(true, telegramSend));
    expect(r.overlayDenied).toBe(true);
    expect(telegramSend).not.toHaveBeenCalled();
    expect(r.sent).not.toBe(true);
  });

  it("вуали нет → фолбэк работает как прежде", async () => {
    const telegramSend = vi.fn(async () => ({ title: "Катя" }));
    const r = await dispatchTool("telegram_send", { to: "Катя", text: "буду через час" }, ctxWith(false, telegramSend));
    expect(telegramSend).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(true);
  });
});
