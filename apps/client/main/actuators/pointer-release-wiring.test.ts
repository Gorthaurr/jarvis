/**
 * Контроль-10 (pointer-release-wiring-untested): фикс контроля-9 состоит из ДВУХ частей — реестра удержаний
 * (`heldButtons` + `releaseHeldPointer`) и ПРОВОДКИ (подписка на смену фазы рисования в `actuators/selection.ts`).
 * Тест контроля-9 звал `releaseHeldPointer()` руками, а сам модуль проводки не импортировал вовсе: удаление
 * подписки оставляло прогон зелёным, и зажатая кнопка жила бы до watchdog сайдкара.
 * Реверт-проверка: убрать `selectionStore.onDrawingChange(...)` из actuators/selection.ts → кейс падает.
 */
import { describe, expect, it, vi } from "vitest";

const sidecarState = vi.hoisted(() => ({ calls: [] as Array<{ method: string; params: Record<string, unknown> }> }));
vi.mock("./sidecar-client.js", () => ({
  sidecar: () => ({
    ready: true,
    request: async (method: string, params: Record<string, unknown>) => {
      sidecarState.calls.push({ method, params });
      return {};
    },
  }),
}));
// Листья, которые тянет actuators/selection.ts: Electron-захват экрана и окна оверлея нам не нужны.
vi.mock("./screen.js", () => ({ getLastCaptureMapping: () => null, captureScreen: async () => ({ image: "", width: 0, height: 0 }), perceptualHash: async () => "0" }));
vi.mock("../selection/overlay.js", () => ({ selectionOverlay: { start: async () => ({}), showFrame: () => undefined, hideAll: () => undefined, submit: () => undefined, drawing: false } }));
vi.mock("electron", () => ({ powerMonitor: { getSystemIdleTime: () => 999 } }));

import "./selection.js"; // ← ИМЕННО проводка: импорт вешает подписку на смену фазы
import { mouse } from "./input.js";
import { selectionStore } from "../selection/store.js";

describe("закрытие вуали САМО отпускает зажатую агентом кнопку", () => {
  it("down → вуаль → закрытие вуали → сайдкар получил ровно один mouse{up}", async () => {
    sidecarState.calls.length = 0;
    selectionStore.setDrawing(false);
    await mouse({ op: "down", button: "left", x: 10, y: 20, space: "screen" });
    selectionStore.setDrawing(true);
    await expect(mouse({ op: "up", button: "left" })).rejects.toThrow(/оверлей/u); // под вуалью отпускать нельзя
    selectionStore.setDrawing(false); // ← вуаль закрылась: подписка обязана отпустить кнопку сама
    await new Promise((r) => setTimeout(r, 5));
    const ups = sidecarState.calls.filter((c) => c.method === "mouse" && c.params.op === "up");
    expect(ups).toHaveLength(1);
    expect(ups[0]?.params.button).toBe("left");
  });
});
