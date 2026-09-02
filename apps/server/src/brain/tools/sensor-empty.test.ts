/**
 * Пустой сенсор: чистая классификация + видимость (деградация) + честная приписка.
 *
 * Дополняет `agent/empty-sensor-loop.test.ts` (там проверяется ПРОВОДКА до петли на ui.snapshot).
 * Здесь — остальные ветки: адверс-ревью 2026-09-01 показало, что `screen.ocr`, `window.list` и
 * особенно `context.read` не были покрыты ничем, а именно context_read гасил долг сверки ОТПРАВКИ:
 * клиентский readContext на UIA-слепом окне возвращает "" БЕЗ ошибки → «Отправлено, сэр» без
 * единого доказательства.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { metrics } from "../../obs/metrics.js";
import { type ToolContext, dispatchTool, sensorPayloadEmpty } from "./dispatch.js";

describe("sensorPayloadEmpty", () => {
  it("screen.ocr: пусто — когда нет ни текста, ни строк", () => {
    expect(sensorPayloadEmpty("screen.ocr", { text: "", lines: [] })).toBe(true);
    expect(sensorPayloadEmpty("screen.ocr", { text: "   ", lines: [] })).toBe(true);
    expect(sensorPayloadEmpty("screen.ocr", { text: "", lines: [{ text: "Играть" }] })).toBe(false);
    expect(sensorPayloadEmpty("screen.ocr", { text: "Играть", lines: [] })).toBe(false);
  });

  it("ui.snapshot: пусто — когда нет элементов", () => {
    expect(sensorPayloadEmpty("ui.snapshot", { items: [] })).toBe(true);
    expect(sensorPayloadEmpty("ui.snapshot", { items: [{ handle: 1 }] })).toBe(false);
  });

  it("window.list: пусто — когда нет окон", () => {
    expect(sensorPayloadEmpty("window.list", { windows: [] })).toBe(true);
    expect(sensorPayloadEmpty("window.list", { windows: [{ hwnd: 1 }] })).toBe(false);
  });

  it("context.read: пустой текст — тоже пустота (гасил долг сверки ОТПРАВКИ)", () => {
    expect(sensorPayloadEmpty("context.read", { text: "" })).toBe(true);
    expect(sensorPayloadEmpty("context.read", { text: "  \n " })).toBe(true);
    expect(sensorPayloadEmpty("context.read", { text: "Кате: привет" })).toBe(false);
  });

  it("не-сенсорные виды пустыми не объявляем (иначе гасили бы им долг ни за что)", () => {
    expect(sensorPayloadEmpty("input.click", {})).toBe(false);
    expect(sensorPayloadEmpty("wait.for", { met: false })).toBe(false);
  });

  it("отсутствие данных = пусто", () => {
    expect(sensorPayloadEmpty("ui.snapshot", undefined)).toBe(true);
  });
});

/** Контекст с сессией, отдающей заданный ActionResult. */
function ctxWith(data: unknown): ToolContext {
  return {
    session: { sendAction: async (_c: ActionCommand): Promise<ActionResult> => ({ commandId: "c", ok: true, data, durationMs: 1 }) },
    userId: "u1",
  } as unknown as ToolContext;
}

describe("пустой сенсор виден и честен", () => {
  it("ui_snapshot без элементов: не сверка, помечен empty, деградация записана", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => {});
    try {
      const r = await dispatchTool("ui_snapshot", {}, ctxWith({ items: [] }));
      expect(r.observed).not.toBe(true);
      expect(r.empty).toBe(true);
      expect(r.content).toContain("НИЧЕГО не увидел");
      expect(spy).toHaveBeenCalledWith("ui_snapshot_empty", expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  it("ui_snapshot С элементами: сверка засчитана, деградации НЕТ", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => {});
    try {
      const r = await dispatchTool("ui_snapshot", {}, ctxWith({ items: [{ handle: 1, role: "Button", name: "Играть" }] }));
      expect(r.observed).toBe(true);
      expect(r.empty).not.toBe(true);
      expect(spy).not.toHaveBeenCalled(); // иначе тест прошёл бы и на БЕЗУСЛОВНОЙ деградации
    } finally {
      spy.mockRestore();
    }
  });

  it("screen_read_text без текста: деградация ocr_empty и не сверка", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => {});
    try {
      const r = await dispatchTool("screen_read_text", {}, ctxWith({ text: "", lines: [] }));
      expect(r.observed).not.toBe(true);
      expect(spy).toHaveBeenCalledWith("ocr_empty", expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  it("context_read с пустым текстом помечается empty (петля не снимет по нему долг)", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => {});
    try {
      const r = await dispatchTool("context_read", {}, ctxWith({ text: "" }));
      expect(r.empty).toBe(true);
      expect(r.content).toContain("НИЧЕГО не увидел");
    } finally {
      spy.mockRestore();
    }
  });
});
