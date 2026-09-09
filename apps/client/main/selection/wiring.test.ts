/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — проводка (контроль-3, 2026-09-05) на подделках Electron-примитивов.
 *
 * Что охраняет каждый кейс (реверт-проверка — что сломать):
 *  • смена состояния → client.selection с возрастом              → убрать sendSelection в onChange;
 *  • отключили монитор с рамкой → выделение снято СИСТЕМОЙ        → убрать revalidate / byOwner:true;
 *  • монитор цел → ничего не снимаем                              → звать clear безусловно;
 *  • хоткей во время рисования = рука владельца (byOwner)          → byOwner:false / start вместо clear;
 *  • хоткей без рисования → start                                 → перепутать ветки;
 *  • клавиша занята / пустой env → hotkey null, без падения        → бросать наружу;
 *  • resendCurrent на (ре)коннекте шлёт текущее с возрастом        → слать null.
 */
import { describe, expect, it, vi } from "vitest";
import type { ScreenSelection } from "@jarvis/protocol";
import { type SelectionWiringDeps, wireSelection } from "./wiring.js";

const SEL: ScreenSelection = { x: 1200, y: 400, w: 640, h: 360, monitorIndex: 1, monitor: "Монитор 2", createdAt: 1_000 };
const D0 = { x: 0, y: 0, width: 1000, height: 800 };
const D1 = { x: 1000, y: 0, width: 2560, height: 1440 };

function harness(over: Partial<SelectionWiringDeps> = {}) {
  const listeners: Array<(sel: ScreenSelection | null) => void> = [];
  let current: ScreenSelection | null = null;
  let hotkeyCb: (() => void) | null = null;
  let displaysCb: ((reason: string) => void) | null = null;
  let connectedCb: (() => void) | null = null;
  let overlayDoneCb: ((id: number, rect: { x: number; y: number; w: number; h: number } | null) => void) | null = null;
  const drawListeners: Array<(on: boolean) => void> = [];
  let drawing = false;
  let displays = [D0, D1];
  const sendSelection = vi.fn();
  const start = vi.fn(async () => undefined);
  const clear = vi.fn(() => ({ cleared: true, drawCancelled: false }));
  const overlay = { drawing: false, submit: vi.fn() };
  const deps: SelectionWiringDeps = {
    store: {
      onChange: (cb) => listeners.push(cb),
      onDrawingChange: (cb) => drawListeners.push(cb),
      get: () => current,
      ageMs: () => (current ? 5_000 : null),
      get drawing() {
        return drawing;
      },
    },
    overlay,
    sendSelection,
    displays: () => displays,
    onDisplaysChanged: (cb) => {
      displaysCb = cb;
    },
    onOverlayDone: (cb) => {
      overlayDoneCb = cb;
    },
    registerHotkey: (_accel, cb) => {
      hotkeyCb = cb;
      return true;
    },
    start,
    clear,
    hotkey: "Control+Alt+X",
    onConnected: (cb) => {
      connectedCb = cb;
    },
    now: () => 6_000,
    ...over,
  };
  const wiring = wireSelection(deps);
  return {
    wiring,
    sendSelection,
    start,
    clear,
    overlay,
    set(sel: ScreenSelection | null) {
      current = sel;
      for (const l of listeners) l(sel);
    },
    setDisplays(d: typeof displays) {
      displays = d;
    },
    setDrawing(on: boolean) {
      drawing = on;
      for (const l of drawListeners) l(on);
    },
    pressHotkey: () => hotkeyCb?.(),
    connected: () => connectedCb?.(),
    overlayDone: (id: number, rect: { x: number; y: number; w: number; h: number } | null) => overlayDoneCb?.(id, rect),
    displaysChanged: (reason = "display-removed") => displaysCb?.(reason),
  };
}

describe("wireSelection — состояние → сервер", () => {
  it("владелец обвёл область → серверу уходит client.selection с ВОЗРАСТОМ; снял → null", () => {
    const h = harness();
    h.set(SEL);
    expect(h.sendSelection).toHaveBeenLastCalledWith(SEL, 5_000, false);
    h.set(null);
    expect(h.sendSelection).toHaveBeenLastCalledWith(null, null, false);
  });

  it("resendCurrent (реконнект) досылает ТЕКУЩЕЕ выделение с возрастом, не null", () => {
    const h = harness();
    h.set(SEL);
    h.sendSelection.mockClear();
    h.wiring.resendCurrent();
    expect(h.sendSelection).toHaveBeenCalledWith(SEL, 5_000, false);
  });

  it("контроль-5: результат рисования из окна-оверлея (selection:done) доходит до overlay.submit — и с рамкой, и с отменой (null)", () => {
    const h = harness();
    h.overlayDone(7, { x: 1, y: 2, w: 3, h: 4 });
    expect(h.overlay.submit).toHaveBeenCalledWith(7, { x: 1, y: 2, w: 3, h: 4 });
    h.overlayDone(7, null);
    expect(h.overlay.submit).toHaveBeenLastCalledWith(7, null);
  });

  it("контроль-4: событие «connected» транспорта САМО досылает выделение — подписка живёт в проводке, не в Electron-entry", () => {
    const h = harness();
    h.set(SEL);
    h.sendSelection.mockClear();
    h.connected();
    expect(h.sendSelection).toHaveBeenCalledWith(SEL, 5_000, false);
  });
});

describe("wireSelection — мониторы", () => {
  it("монитор с рамкой отключили → выделение снято СИСТЕМОЙ (byOwner:false)", () => {
    const h = harness();
    h.set(SEL);
    h.setDisplays([D0]); // второго монитора больше нет — координаты осиротели
    h.displaysChanged("display-removed");
    expect(h.clear).toHaveBeenCalledWith({ byOwner: false });
  });

  it("конфигурация сменилась, но область по-прежнему на своём мониторе → ничего не снимаем", () => {
    const h = harness();
    h.set(SEL);
    h.displaysChanged("display-metrics-changed");
    expect(h.clear).not.toHaveBeenCalled();
  });
});

describe("wireSelection — горячая клавиша", () => {
  it("во время рисования повторный хоткей гасит вуаль РУКОЙ ВЛАДЕЛЬЦА (byOwner:true), start не зовётся", () => {
    const h = harness();
    h.overlay.drawing = true;
    h.pressHotkey();
    expect(h.clear).toHaveBeenCalledWith({ byOwner: true });
    expect(h.start).not.toHaveBeenCalled();
  });

  it("без рисования хоткей открывает оверлей (start), clear не зовётся", () => {
    const h = harness();
    h.pressHotkey();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.wiring.hotkey).toBe("Control+Alt+X");
  });

  it("клавиша занята другой программой → hotkey null (в паспорт уедет честное «не зарегистрирована»)", () => {
    const h = harness({ registerHotkey: () => false });
    expect(h.wiring.hotkey).toBeNull();
  });

  it("регистрация бросила → не падаем, hotkey null; пустой env → не регистрируем вовсе", () => {
    const throwing = harness({
      registerHotkey: () => {
        throw new Error("bad accelerator");
      },
    });
    expect(throwing.wiring.hotkey).toBeNull();
    const reg = vi.fn(() => true);
    const none = harness({ hotkey: "   ", registerHotkey: reg });
    expect(none.wiring.hotkey).toBeNull();
    expect(reg).not.toHaveBeenCalled();
  });
});

// Контроль-9 (browser-open-ext-bypasses-veil): сервер обязан узнать о ФАЗЕ РИСОВАНИЯ сразу — по ней гейтятся
// пути, не проходящие через клиентский dispatch (browser_open через расширение).
describe("wireSelection — фаза рисования уезжает серверу", () => {
  it("вуаль открылась/закрылась → client.selection с drawing", () => {
    const h = harness();
    h.setDrawing(true);
    expect(h.sendSelection).toHaveBeenLastCalledWith(null, null, true);
    h.setDrawing(false);
    expect(h.sendSelection).toHaveBeenLastCalledWith(null, null, false);
  });
});
