/**
 * Контроль-9 (mouse-up-terminates-owner-drawing): раз `input.mouse{op:"up"}` под вуалью больше не пропускается
 * (он завершил бы выделение владельца в точке курсора), отпустить зажатую кнопку обязаны МЫ — в момент закрытия
 * вуали. Реверт-проверка: убрать реестр heldButtons / вызов releaseHeldPointer → кейс падает.
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
vi.mock("./screen.js", () => ({ getLastCaptureMapping: () => null }));
vi.mock("electron", () => ({ powerMonitor: { getSystemIdleTime: () => 999 } }));

import { mouse, releaseHeldPointer } from "./input.js";
import { selectionStore } from "../selection/store.js";

describe("зажатая кнопка мыши отпускается после закрытия вуали", () => {
  it("down → вуаль → up отвергнут → закрытие вуали отпускает кнопку", async () => {
    sidecarState.calls.length = 0;
    selectionStore.setDrawing(false);
    await mouse({ op: "down", button: "left", x: 10, y: 20, space: "screen" });
    selectionStore.setDrawing(true);
    await expect(mouse({ op: "up", button: "left" })).rejects.toThrow(); // не даём завершить выделение владельца
    await releaseHeldPointer();
    const ups = sidecarState.calls.filter((c) => c.method === "mouse" && c.params.op === "up");
    expect(ups).toHaveLength(1);
    expect(ups[0]?.params.button).toBe("left");
    expect(ups[0]?.params.x).toBeUndefined(); // отпускаем НА МЕСТЕ: курсор не переставляем
    selectionStore.setDrawing(false);
  });
});

// Контроль-10 (release-held-pointer-silent): авто-отпускание видимо. Кнопка отпускается ТАМ, ГДЕ КУРСОР владельца,
// то есть перетаскивание завершилось не там, где планировал агент — молчаливое «ok» на следующий `up` было бы
// ложным «ничего не случилось».
describe("авто-отпускание кнопки не молчит", () => {
  it("после отпускания системой следующий up — честная ошибка «исход не подтверждён»", async () => {
    sidecarState.calls.length = 0;
    selectionStore.setDrawing(false);
    await mouse({ op: "down", button: "left", x: 10, y: 20, space: "screen" });
    await releaseHeldPointer();
    await expect(mouse({ op: "up", button: "left" })).rejects.toThrow(/ИСХОД НЕ ПОДТВЕРЖДЁН/u);
    // Сообщаем ОДИН раз: следующий up снова обычный.
    await expect(mouse({ op: "up", button: "left" })).resolves.toBeUndefined();
  });
});
