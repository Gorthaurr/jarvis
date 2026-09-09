/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — контроль-6 (SR-C6-1, защита в глубину): apps.focusApp / windows.focusWindow под вуалью бросают
 * DrawingOverlayError В ТОЧКЕ ДЕЙСТВИЯ — реплей навыка зовёт их напрямую, мимо раннего гейта dispatch (тот же класс,
 * что гейт input.* в точке инжекции). Без сайдкара и без Electron: гард стоит ДО ensure().
 * Реверт-проверка: убрать assertNoDrawingOverlay из focusApp/focusWindow → оба кейса падают.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../monitors.js", () => ({ monitors: { displayForRect: () => undefined } }));
// Контроль-9: состояние сайдкара управляемое — нужен сценарий «вуаль открылась ВНУТРИ RPC».
const sidecarState = vi.hoisted(() => ({ ready: false, request: async (_m: string, _p?: unknown): Promise<unknown> => ({}) }));
vi.mock("./sidecar-client.js", () => ({ sidecar: () => ({ get ready() { return sidecarState.ready; }, request: (m: string, p?: unknown) => sidecarState.request(m, p) }) }));
const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnSpy(...a) }));

import { focusApp, launchApp } from "./apps.js";
import { focusWindow } from "./windows.js";
import { selectionStore } from "../selection/store.js";
import { DrawingOverlayError } from "../selection/overlay-error.js";

describe("focusApp / focusWindow под вуалью — гард в точке действия", () => {
  afterEach(() => {
    selectionStore.setDrawing(false);
    sidecarState.ready = false;
    sidecarState.request = async () => ({});
    spawnSpy.mockClear();
  });

  it("windows.focusWindow: под вуалью — DrawingOverlayError ДО сайдкара; без вуали — доходит до сайдкара (NotImplemented без него)", async () => {
    selectionStore.setDrawing(true);
    await expect(focusWindow({ query: "Discord" })).rejects.toBeInstanceOf(DrawingOverlayError);
    selectionStore.setDrawing(false);
    await expect(focusWindow({ query: "Discord" })).rejects.toThrow(/сайдкар/u);
  });

  it("apps.focusApp: под вуалью — DrawingOverlayError, ни сайдкар, ни AppActivate не зовутся", async () => {
    selectionStore.setDrawing(true);
    await expect(focusApp("discord")).rejects.toBeInstanceOf(DrawingOverlayError);
  });

  it("контроль-7 (sensors-3): apps.launchApp под вуалью — DrawingOverlayError ДО резолва/запуска (новое окно отобрало бы клавиатуру у рисования)", async () => {
    selectionStore.setDrawing(true);
    await expect(launchApp("notepad")).rejects.toBeInstanceOf(DrawingOverlayError);
  });
});

// Контроль-9 (focus-app-veil-swallowed): между входным гардом focusApp и AppActivate лежит сайдкарный RPC с
// таймаутом 8 с — вуаль успевает открыться внутри окна. Общий catch превращал честный отказ в «сайдкар
// недоступен», после чего PowerShell выводил чужое окно поверх окна рисования и возвращал чистый ok.
describe("focusApp: вуаль, открывшаяся ВО ВРЕМЯ фокусировки", () => {
  it("вуаль открылась в RPC сайдкара → отказ наверх, PowerShell не зовётся", async () => {
    selectionStore.setDrawing(false);
    sidecarState.ready = true;
    sidecarState.request = async () => {
      selectionStore.setDrawing(true); // владелец нажал Ctrl+Alt+X, пока шёл window.focus
      return { focused: false };
    };
    await expect(focusApp("discord")).rejects.toBeInstanceOf(DrawingOverlayError);
    expect(spawnSpy).not.toHaveBeenCalled(); // до фикса: AppActivate менял фокус под открытой вуалью
  });

  it("исключение вуали ИЗ сайдкара не глотается catch'ем", async () => {
    selectionStore.setDrawing(false);
    sidecarState.ready = true;
    sidecarState.request = async () => {
      throw new DrawingOverlayError("Поверх экрана открыт оверлей режима выделения");
    };
    await expect(focusApp("discord")).rejects.toBeInstanceOf(DrawingOverlayError);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// Контроль-10 (focus-no-postcheck): гард на входе не покрывает САМ RPC — внутри него сайдкар делает SW_RESTORE +
// SetForegroundWindow + ALT-нудж (сотни мс инжекции), а readback честно рапортует focused:true.
describe("вуаль, открывшаяся ВНУТРИ смены фокуса", () => {
  it("window.focus: отказ с признаком «действие ушло», а не чистый ok", async () => {
    selectionStore.setDrawing(false);
    sidecarState.ready = true;
    sidecarState.request = async () => {
      selectionStore.setDrawing(true);
      return { focused: true, hwnd: 7, title: "Discord" };
    };
    // Вуаль открылась ВНУТРИ RPC → это не «не пустили», а «действие УЖЕ УШЛО»: сервер обязан получить
    // stepActionInjected, а не читать раунд провалом модели.
    await expect(focusWindow({ query: "Discord" })).rejects.toMatchObject({ name: "DrawingOverlayError", injected: true });
  });
});
