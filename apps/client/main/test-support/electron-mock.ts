/**
 * W2 (пакет 0): мок модуля `electron` для тестов клиента — clipboard, BrowserWindow, screen (+ powerMonitor,
 * desktopCapturer), с управляемым состоянием. На Linux у настоящего Electron нет Windows-API перевода физика ↔ DIP
 * (`screenToDipRect`, `dipToScreenPoint`) — мок считает их по `state.scale` (масштаб 1,5 = 150 %).
 *
 * Подключение в тесте:
 *   vi.mock("electron", async () => (await import("../test-support/electron-mock.js")).electronModule);
 *   beforeEach(() => resetElectronMock({ scale: 1.5 }));
 */

export interface ElectronMockState {
  clipboardText: string;
  /** Окно Джарвиса в фокусе (BrowserWindow.getFocusedWindow() !== null). */
  ownFocused: boolean;
  /** Масштаб экрана: физика = DIP × scale. */
  scale: number;
  idleSec: number;
  displays: Array<{ id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; size: { width: number; height: number } }>;
}

const fresh = (): ElectronMockState => ({
  clipboardText: "",
  ownFocused: false,
  scale: 1,
  idleSec: 999,
  displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, size: { width: 1920, height: 1080 } }],
});

export const electronState: ElectronMockState = fresh();

export function resetElectronMock(over: Partial<ElectronMockState> = {}): ElectronMockState {
  Object.assign(electronState, fresh(), over);
  return electronState;
}

const ownWindow = { id: 1, isVisible: () => true, getBounds: () => ({ x: 0, y: 0, width: 400, height: 300 }) };

export const electronModule = {
  clipboard: {
    readText: () => electronState.clipboardText,
    writeText: (t: string) => {
      electronState.clipboardText = t;
    },
    availableFormats: () => (electronState.clipboardText ? ["text/plain"] : []),
    readHTML: () => "",
    readRTF: () => "",
    readImage: () => ({ isEmpty: () => true }),
    clear: () => {
      electronState.clipboardText = "";
    },
    write: (d: { text?: string }) => {
      electronState.clipboardText = d.text ?? "";
    },
  },
  BrowserWindow: {
    getFocusedWindow: () => (electronState.ownFocused ? ownWindow : null),
    getAllWindows: () => [ownWindow],
  },
  screen: {
    screenToDipRect: (_w: unknown, r: { x: number; y: number; width: number; height: number }) => {
      const s = electronState.scale;
      return { x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s };
    },
    dipToScreenPoint: (p: { x: number; y: number }) => ({ x: Math.round(p.x * electronState.scale), y: Math.round(p.y * electronState.scale) }),
    getAllDisplays: () => electronState.displays,
    getPrimaryDisplay: () => electronState.displays[0],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => electronState.displays[0],
  },
  powerMonitor: { getSystemIdleTime: () => electronState.idleSec },
  app: {
    getPath: () => {
      throw new Error("no userData in test");
    },
  },
  desktopCapturer: { getSources: async () => [] },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) },
};

export default electronModule;
