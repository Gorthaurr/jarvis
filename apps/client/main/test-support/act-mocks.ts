/**
 * W2 (пакет 0): общие моки ЛИСТЬЕВ примитива act (сайдкар-грундинг, ввод, OCR, наблюдение, окна) для трёх файлов
 * тестов: act.test.ts (оркестратор, П1), act-find.test.ts (поиск, П5), act-do.test.ts (действие, П4). Файлы разрезаны,
 * чтобы пакеты не писали в один тест-файл; моки — одни (у input.js есть и mouse — глаголы указателя П4).
 *
 * Подключение (фабрики vi.mock видят состояние из vi.hoisted):
 *   const st = await vi.hoisted(async () => (await import("../test-support/act-mocks.js")).createActState());
 *   vi.mock("./ground.js", async () => (await import("../test-support/act-mocks.js")).actMocks.ground(st));
 *   beforeEach(async () => (await import("../test-support/act-mocks.js")).resetActState(st));
 */
import { vi } from "vitest";

type Box = { x: number; y: number; w: number; h: number };
export type SnapItem = { handle: number; role: string; name: string; automationId?: string; value?: string } & Box;
type Wait = { met: boolean; elapsedMs: number; polls: number; detail: string; unknown?: boolean };

export function createActState() {
  return {
    items: [] as SnapItem[],
    truncated: false,
    snapshotPid: 1,
    snapshotCalls: 0,
    ocr: { text: "", lines: [] as Array<{ text: string } & Box>, mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } as { boundsX: number; boundsY: number; scale: number } | undefined },
    ocrCalls: 0,
    groundAt: async (_x: number, _y: number): Promise<{ handle: string; bbox?: Box; name?: string; role?: string }> => ({ handle: "77", bbox: { x: 0, y: 0, w: 80, h: 30 } }),
    invoke: vi.fn(async (_t: unknown, _p: string, _v?: string): Promise<void> => undefined),
    click: vi.fn(async (_t: unknown, _m?: string, _r?: boolean, _o?: unknown): Promise<{ screenX: number; screenY: number } | undefined> => undefined),
    typeText: vi.fn(async (_t: string): Promise<void> => undefined),
    pressKey: vi.fn(async (_c: string): Promise<void> => undefined),
    mouse: vi.fn(async (_p: unknown): Promise<void> => undefined),
    pasteText: vi.fn(async (_t: string): Promise<void> => undefined),
    wait: async (_timeoutMs?: number): Promise<Wait> => ({ met: true, elapsedMs: 120, polls: 1, detail: "видно «Отправлено»" }),
    waitCalls: [] as unknown[],
    captureCalls: 0,
    observeCalls: 0,
    observation: undefined as unknown,
    focusWindow: async (_o: unknown): Promise<{ focused: boolean; hwnd: number; title: string }> => ({ focused: true, hwnd: 1, title: "Telegram" }),
    focusApp: async (_a: string): Promise<{ resolved: string; focused: boolean }> => ({ resolved: "x", focused: false }),
    /** Процесс на переднем плане для §14-рубежа act (контроль-2 №4). */
    fg: null as string | null,
  };
}
export type ActState = ReturnType<typeof createActState>;

export const btn = (handle: number, name: string, role = "Button", extra: Partial<SnapItem> = {}): SnapItem => ({ handle, role, name, x: 0, y: 0, w: 10, h: 10, ...extra });

/** Дефолты перед каждым кейсом: Telegram с «Отправить», «Отправить всем», полем «Поиск». */
export function resetActState(st: ActState): void {
  Object.assign(st, { items: [btn(11, "Отправить"), btn(12, "Отправить всем"), btn(13, "Поиск", "Edit")], truncated: false, snapshotPid: 1, snapshotCalls: 0, ocrCalls: 0, waitCalls: [], captureCalls: 0, observeCalls: 0, fg: null });
  st.ocr = { text: "", lines: [], mapping: { boundsX: 0, boundsY: 0, scale: 0.5 } };
  st.groundAt = async () => ({ handle: "77", bbox: { x: 0, y: 0, w: 80, h: 30 } });
  for (const f of [st.invoke, st.click, st.typeText, st.pressKey, st.mouse, st.pasteText]) f.mockReset();
  // Предпроверка (500 мс, до действия) — признака ещё нет; сверка после действия — признак наступил.
  st.wait = async (timeoutMs?: number) =>
    (timeoutMs ?? 0) <= 500 ? { met: false, elapsedMs: 500, polls: 1, detail: "ещё нет" } : { met: true, elapsedMs: 120, polls: 1, detail: "видно «Отправлено»" };
  st.observation = { via: "a11y", text: "+ появилось «Отправлено»", delta: true, changed: true };
  st.focusWindow = async () => ({ focused: true, hwnd: 1, title: "Telegram" });
  st.focusApp = async () => ({ resolved: "x", focused: false });
}

export const actMocks = {
  ground: (st: ActState) => ({
    uiSnapshot: async () => {
      st.snapshotCalls += 1;
      return { window: "W", pid: st.snapshotPid, items: st.items, truncated: st.truncated };
    },
    groundAtPoint: (x: number, y: number) => st.groundAt(x, y),
    invoke: (t: unknown, p: string, v?: string) => st.invoke(t, p, v),
  }),
  screen: () => ({}), // W2 П5: координаты — кадры (frames.ts), глобального lastMapping нет
  sensors: (st: ActState) => ({
    screenOcr: async () => {
      st.ocrCalls += 1;
      return { ...st.ocr, width: 100, height: 100 };
    },
    waitFor: async (cond: unknown, timeoutMs: number) => {
      st.waitCalls.push({ cond, timeoutMs });
      return st.wait(timeoutMs);
    },
  }),
  input: (st: ActState) => ({
    click: (t: unknown, m?: string, r?: boolean, o?: unknown) => st.click(t, m, r, o),
    typeText: (t: string) => st.typeText(t),
    pressKey: (c: string) => st.pressKey(c),
    mouse: (p: unknown) => st.mouse(p),
  }),
  paste: (st: ActState) => ({ PASTE_FROM_CHARS: 80, pasteText: (t: string) => st.pasteText(t), pasteNote: () => "" }),
  observe: (st: ActState) => ({
    captureUiFingerprint: async () => {
      st.captureCalls += 1;
      return { lines: ["Button: Отправить"] };
    },
    observeAfterAction: async () => {
      st.observeCalls += 1;
      return st.observation;
    },
  }),
  windows: (st: ActState) => ({
    focusWindow: (o: unknown) => st.focusWindow(o),
    listWindows: async () => (st.fg ? [{ foreground: true, process: st.fg }] : []),
  }),
  apps: (st: ActState) => ({ focusApp: (a: string) => st.focusApp(a) }),
};
