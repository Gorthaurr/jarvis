/**
 * Контроль-9 (window-arrange-no-point-guard): раннего гейта dispatch мало — между ним и самой перестановкой окна
 * лежит `listWindows` (RPC сайдкара, таймаут 8 с), и вуаль успевает открыться внутри этого окна. SW_RESTORE/
 * SW_MAXIMIZE активируют окно поверх окна рисования, Esc владельца уходит в чужое приложение, а инструмент
 * возвращал чистый ok. Реверт-проверка: убрать assertNoDrawingOverlay из arrangeWindow → кейс падает (PowerShell
 * был бы вызван).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnSpy(...a) }));
vi.mock("electron", () => ({ screen: { getAllDisplays: () => [], dipToScreenRect: (_w: unknown, r: unknown) => r } }));
vi.mock("../monitors.js", () => ({ monitors: { hasMultiple: false, displayForRect: () => ({ index: 0, primary: true }) } }));

import { arrangeWindow } from "./window-arrange.js";
import { selectionStore } from "../selection/store.js";
import { DrawingOverlayError } from "../selection/overlay-error.js";

describe("window.arrange под вуалью — гард в точке действия", () => {
  afterEach(() => {
    selectionStore.setDrawing(false);
    spawnSpy.mockClear();
  });

  it("вуаль открылась, пока читали список окон → отказ ДО PowerShell", async () => {
    selectionStore.setDrawing(true);
    await expect(arrangeWindow({ hwnd: 5, op: "maximize" })).rejects.toBeInstanceOf(DrawingOverlayError);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("minimize фокус не отбирает — гейт его не касается (окно уезжает вниз, поверх ничего не встаёт)", async () => {
    selectionStore.setDrawing(true);
    await arrangeWindow({ hwnd: 5, op: "minimize" }).catch(() => undefined); // дальше уйдёт в PowerShell-мок
    expect(spawnSpy).toHaveBeenCalled();
  });
});
