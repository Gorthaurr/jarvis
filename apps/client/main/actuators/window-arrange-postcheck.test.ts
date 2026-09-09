/**
 * Контроль-10 (arrange-no-postcheck): гард стоит ПЕРЕД самым длинным окном инжекции — `run(env)` спавнит
 * PowerShell, который компилирует C#-сигнатуры через Add-Type (секунды) и лишь потом делает ShowWindow.
 * Вуаль, открывшаяся внутри этого окна, получает чужое окно поверх себя, а инструмент возвращал чистый ok.
 * Реверт-проверка: убрать assertNoOverlayDuring после run(env) → кейс падает.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnSpy = vi.hoisted(() =>
  vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      // Пока PowerShell «работает», владелец открывает режим выделения.
      selectionStore.setDrawing(true);
      child.stdout.emit("data", "0\t0\t100\t100\t0\t1"); // формат parseArrange: шесть полей через таб
      child.emit("close", 0);
    }, 5);
    return child;
  }),
);
vi.mock("node:child_process", () => ({ spawn: () => spawnSpy() }));
vi.mock("electron", () => ({ screen: { getAllDisplays: () => [], dipToScreenRect: (_w: unknown, r: unknown) => r } }));
vi.mock("../monitors.js", () => ({ monitors: { hasMultiple: false, displayForRect: () => ({ index: 0, primary: true }) } }));

import { arrangeWindow } from "./window-arrange.js";
import { selectionStore } from "../selection/store.js";
import { DrawingOverlayError } from "../selection/overlay-error.js";

describe("window.arrange: вуаль, открывшаяся ВО ВРЕМЯ перестановки", () => {
  afterEach(() => {
    selectionStore.setDrawing(false);
    spawnSpy.mockClear();
  });

  it("окно активировано под открывшейся вуалью → честный отказ, а не ok", async () => {
    await expect(arrangeWindow({ hwnd: 5, op: "maximize" })).rejects.toBeInstanceOf(DrawingOverlayError);
    expect(spawnSpy).toHaveBeenCalled(); // действие УЖЕ ушло — потому и «исход не подтверждён»
  });
});
