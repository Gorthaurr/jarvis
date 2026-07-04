import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext, visionFallbackHint } from "./dispatch.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
function ctxWith(sendAction: Send): ToolContext {
  return { session: { sendAction }, userId: "u1" } as unknown as ToolContext;
}

// Зрение (§): screen_capture снимает экран и возвращает КАРТИНКУ модели (image-блок), а не
// stringify. Захват (Electron desktopCapturer) живой тут не проверить — проверяем конвертацию.
describe("dispatch screen_capture — зрение", () => {
  it("успешный захват → tool_result с текстом + image-блоком (base64 как есть)", async () => {
    const sendAction = vi.fn<Send>(async (cmd) => {
      expect(cmd.kind).toBe("screen.capture");
      return { commandId: "c", ok: true, data: { image: "QkFTRTY0", mediaType: "image/png" }, durationMs: 1 };
    });
    const r = await dispatchTool("screen_capture", { note: "что в редакторе" }, ctxWith(sendAction));
    expect(sendAction).toHaveBeenCalled();
    expect(r.isError).toBe(false);
    expect(Array.isArray(r.content)).toBe(true);
    const blocks = r.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect(String(blocks[0]!.text)).toContain("что в редакторе");
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QkFTRTY0" },
    });
  });

  it("захват без картинки → честная ошибка строкой (не пустой image-блок)", async () => {
    const r = await dispatchTool(
      "screen_capture",
      {},
      ctxWith(async () => ({ commandId: "c", ok: true, data: {}, durationMs: 1 })),
    );
    expect(r.isError).toBe(true);
    expect(typeof r.content).toBe("string");
  });

  it("сбой актуатора захвата → ошибка с причиной", async () => {
    const r = await dispatchTool(
      "screen_capture",
      {},
      ctxWith(async () => ({
        commandId: "c",
        ok: false,
        error: { code: "runtime", message: "нет источника экрана" },
        durationMs: 1,
      })),
    );
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("нет источника экрана");
  });
});

// Зрение как УНИВЕРСАЛЬНАЯ подложка: промах a11y/UIA → подсказка модели «сними экран, кликни по
// координатам, переснимай и сверь» (pillar 2 концепта+100%). Хинт только для grounding-действий и
// только на промахе элемента — не на таймауте/сетевой ошибке и не на не-UIA действиях.
describe("visionFallbackHint — a11y-miss → vision", () => {
  it("ui.ground / not_found → подсказывает screen_capture + клик по координатам", () => {
    const h = visionFallbackHint("ui.ground", "not_found", "элемент не найден");
    expect(h).toContain("screen_capture");
    expect(h).toContain("координат");
    expect(h).toContain("сверь");
  });

  it("input.click с «элемент не найден» → подсказка (грундинг по role промахнулся)", () => {
    expect(visionFallbackHint("input.click", "runtime", "элемент не найден для клика")).toContain("screen_capture");
  });

  it("НЕ-грундинг действие (app.launch) → без подсказки", () => {
    expect(visionFallbackHint("app.launch", "not_found", "приложение не найдено")).toBe("");
  });

  it("грундинг, но НЕ промах элемента (таймаут/сеть) → без подсказки", () => {
    expect(visionFallbackHint("ui.invoke", "timeout", "превышено время")).toBe("");
  });

  it("e2e: input_click → not_found → ошибка содержит зрение-подсказку", async () => {
    const r = await dispatchTool(
      "input_click",
      { target: { by: "role", role: "button", name: "Играть" } },
      ctxWith(async () => ({ commandId: "c", ok: false, error: { code: "not_found", message: "элемент не найден" }, durationMs: 1 })),
    );
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("screen_capture");
  });
});
