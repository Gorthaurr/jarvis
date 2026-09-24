/**
 * Контроль-9 (browser-open-ext-bypasses-veil): гейт вуали у `browser_open` стоял ТОЛЬКО в ветке `sendAction`
 * (расширение не подключено). При подключённом расширении — штатное состояние по карте проекта — `openOrFocus`
 * зовёт `chrome.windows.update{focused:true, drawAttention:true}`: окно Chrome встаёт поверх окна рисования и
 * забирает клавиатуру, Esc владельца уходит в браузер, и рамку штатно не снять до таймаута вуали.
 * Реверт-проверка: убрать проверку `ctx.veilDrawing` из browserOpen → оба кейса падают.
 */
import { describe, expect, it, vi } from "vitest";
import { dispatchTool, type ToolContext } from "../dispatch.js";

function ctxWith(drawing: boolean, openOrFocus: ReturnType<typeof vi.fn>): ToolContext {
  return {
    session: { sendAction: vi.fn(async () => ({ commandId: "c", ok: true, durationMs: 1 })) },
    userId: "u1",
    ext: { connected: true, openOrFocus },
    veilDrawing: () => drawing,
  } as unknown as ToolContext;
}

describe("browser_open под вуалью режима выделения", () => {
  it("расширение подключено, идёт рисование → честный отказ вуали, вкладку НЕ поднимаем", async () => {
    const openOrFocus = vi.fn(async () => ({ focused: true, tabId: 5 }));
    const r = await dispatchTool("browser_open", { url: "https://youtube.com" }, ctxWith(true, openOrFocus));
    expect(r.isError).toBe(true);
    expect(r.overlayDenied).toBe(true);
    expect(openOrFocus).not.toHaveBeenCalled(); // до фикса: окно браузера отбирало клавиатуру у окна рисования
  });

  it("вуали нет → прежний путь через расширение", async () => {
    const openOrFocus = vi.fn(async () => ({ focused: false, tabId: 5 }));
    const r = await dispatchTool("browser_open", { url: "https://youtube.com" }, ctxWith(false, openOrFocus));
    expect(r.isError).toBe(false);
    expect(openOrFocus).toHaveBeenCalledTimes(1);
  });
});
