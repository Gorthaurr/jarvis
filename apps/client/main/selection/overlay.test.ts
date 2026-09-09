/**
 * §РЕЖИМ ВЫДЕЛЕНИЯ — жизненный цикл окон-оверлеев на подделке Electron (контроль-ревью 2026-09-05).
 *
 * Охраняет: окно рисования, исчезнувшее ИЗВНЕ (Alt+F4 владельца / крах рендерера), не оставляет `drawing`
 * залипшим — иначе гейт ввода утверждал бы «открыт оверлей» при пустом экране, а повторный start
 * присоединялся бы к мёртвому рисованию; повторный start присоединяется к ЖИВОМУ; таймаут вуали закрывает
 * фазу исходом системы, не владельца.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, size: { width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 760 }, scaleFactor: 1 };
const DISPLAY2 = { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 800 }, size: { width: 1000, height: 800 }, workArea: { x: 1000, y: 0, width: 1000, height: 760 }, scaleFactor: 1 };
/** Набор мониторов подделки — тесты мультимонитора добавляют второй и возвращают один. */
const displays: (typeof DISPLAY)[] = [DISPLAY];
const wins: FakeWin[] = [];
let nextId = 1;

class FakeContents extends EventEmitter {
  id = nextId++;
  send = vi.fn();
}
class FakeWin extends EventEmitter {
  webContents = new FakeContents();
  private destroyed = false;
  constructor(public opts: Record<string, unknown>) {
    super();
    wins.push(this);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed"); // Electron эмитит 'closed' и при destroy()
  }
  show = vi.fn();
  focus = vi.fn();
  showInactive = vi.fn();
  setAlwaysOnTop = vi.fn();
  setVisibleOnAllWorkspaces = vi.fn();
  setContentProtection = vi.fn();
  setIgnoreMouseEvents = vi.fn();
  loadFile = vi.fn();
  getBounds = () => DISPLAY.bounds;
}

vi.mock("electron", () => ({
  BrowserWindow: FakeWin,
  app: { getPath: () => process.env.TEMP ?? "." },
  screen: {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => DISPLAY,
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => DISPLAY,
    screenToDipPoint: (p: { x: number; y: number }) => p,
  },
}));

const { SelectionOverlay } = await import("./overlay.js");
const { selectionStore } = await import("./store.js");

beforeEach(() => {
  wins.length = 0;
  selectionStore.setDrawing(false);
});
afterEach(() => vi.useRealTimers());

describe("SelectionOverlay — окно исчезло извне", () => {
  it("владелец закрыл окно рисования (Alt+F4) → фаза закрыта его рукой, drawing снят, ждущие получают исход", async () => {
    const ov = new SelectionOverlay();
    const p = ov.start();
    expect(ov.drawing).toBe(true);
    expect(selectionStore.drawing).toBe(true);
    wins[0]!.destroy(); // как если бы окно закрыла ОС по Alt+F4 — submit не придёт никогда
    expect(await p).toEqual({ cancelled: true, reason: "esc" });
    expect(ov.drawing).toBe(false);
    expect(selectionStore.drawing).toBe(false);
  });

  it("рендерер упал → исход failed (сбой системы), окно уничтожено", async () => {
    const ov = new SelectionOverlay();
    const p = ov.start();
    wins[0]!.webContents.emit("render-process-gone");
    expect(await p).toEqual({ failed: true, failReason: "crashed" }); // серверу — «открылся, но упал», не «не создались»
    expect(wins[0]!.isDestroyed()).toBe(true);
    expect(ov.drawing).toBe(false);
  });
});

describe("SelectionOverlay — два монитора (контроль-3)", () => {
  it("Alt+F4 на ОДНОМ окне рисования закрывает фазу на ВСЕХ: drawing снят, второе окно уничтожено, исход — рука владельца", async () => {
    displays.push(DISPLAY2);
    try {
      const ov = new SelectionOverlay();
      const p = ov.start();
      expect(wins).toHaveLength(2);
      wins[0]!.destroy(); // владелец закрыл фокусное окно — на его мониторе вуали больше нет
      expect(await p).toEqual({ cancelled: true, reason: "esc" });
      expect(ov.drawing).toBe(false); // раньше залипало до таймаута: «открыт оверлей» при пустом экране
      expect(selectionStore.drawing).toBe(false);
      expect(wins[1]!.isDestroyed()).toBe(true); // частичной вуали на втором мониторе нет
    } finally {
      displays.length = 1;
    }
  });
});

describe("SelectionOverlay — присоединение и таймаут", () => {
  it("второй start во время рисования НЕ открывает новых окон и получает тот же исход", async () => {
    const ov = new SelectionOverlay();
    const p1 = ov.start();
    const p2 = ov.start();
    expect(wins).toHaveLength(1); // один монитор — одно окно, без перезапуска
    ov.submit(wins[0]!.webContents.id, { x: 100, y: 100, w: 300, h: 200 });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.selection).toMatchObject({ x: 100, y: 100, w: 300, h: 200, monitorIndex: 0 });
    expect(b).toBe(a);
  });

  it("таймаут вуали закрывает фазу исходом СИСТЕМЫ (reason: timeout), окна уничтожены", async () => {
    vi.useFakeTimers();
    const ov = new SelectionOverlay();
    const p = ov.start();
    await vi.advanceTimersByTimeAsync(120_000 + 10);
    expect(await p).toEqual({ cancelled: true, reason: "timeout" });
    expect(wins[0]!.isDestroyed()).toBe(true);
    expect(ov.drawing).toBe(false);
  });

  it("submit от окна не из фазы рисования игнорируется (рамка исход не решает)", async () => {
    const ov = new SelectionOverlay();
    const p = ov.start();
    ov.submit(9999, { x: 1, y: 1, w: 100, h: 100 });
    expect(ov.drawing).toBe(true); // ничего не произошло
    ov.submit(wins[0]!.webContents.id, null);
    expect(await p).toEqual({ cancelled: true, reason: "esc" });
  });
});
