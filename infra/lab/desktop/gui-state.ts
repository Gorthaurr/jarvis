export { ActionError } from "./gui-errors.js";
export { FRAME_LRU_MAX,getFrame,registerFrame,toScreenPoint,toScreenRect } from "./gui-frames.js";
export type { CoordSpace,Frame,FrameKind,GuiState,Rect,Selection } from "./gui-state-types.js";
import type { GuiState, Rect } from "./gui-state-types.js";
/**
 * Состояние GUI-половины FakeDesktop, которого нет в DesktopCore: кадры задачи (frameId), z-порядок, курсор, вуаль и
 * выделение, GSI-пуши, наблюдение за файлами, модели окон. Живёт ВНЕ core.ts (чужой файл) и привязано к эпохе сброса:
 * `core.reset` пересоздаёт `core.effects`, значит смена ссылки на массив = новый прогон, и состояние рождается заново.
 */
import type { DesktopEffect, DesktopWindow } from "../lib/contracts.js";
import type { DesktopCore } from "./core.js";

/** Отпечаток содержимого области в момент выделения (ставит gui-scene при загрузке; без него changedSinceSelection не утверждается). */
let hasher: ((core: DesktopCore, r: Rect) => string) | null = null;
export const setSelectionHasher = (f: (core: DesktopCore, r: Rect) => string): void => {
  hasher = f;
};
const states = new WeakMap<object, GuiState>();
const wired = new WeakSet<object>();

function fresh(core: DesktopCore): GuiState {
  const p = core.monitors.find((m) => m.primary) ?? core.monitors[0];
  return {
    epoch: core.effects,
    frameSeq: 0,
    frames: new Map(),
    z: [],
    cursor: p ? { x: Math.round(p.x + p.w / 2), y: Math.round(p.y + p.h / 2) } : { x: 0, y: 0 },
    jarvisMonitor: null,
    monitorTarget: "jarvis",
    selection: null,
    plannedSelection: null,
    drawing: false,
    gsi: new Map(),
    fileWatch: new Map(),
    held: new Set(),
    mouseDown: null,
    recording: false,
    ownerInputAt: Number.NEGATIVE_INFINITY,
    models: new WeakMap(),
  };
}

/** Внешние события «владельца» (FakeDesktop.userAction → эффект user.*): рамка выделения, GSI-пуш программы. */
function onUserEvent(core: DesktopCore, e: DesktopEffect): void {
  const st = guiState(core);
  const d = e.detail;
  if (e.kind === "user.selection") {
    const monitorIndex = typeof d.monitorIndex === "number" ? d.monitorIndex : 0;
    const r = { x: Number(d.x ?? 0), y: Number(d.y ?? 0), w: Number(d.w ?? 0), h: Number(d.h ?? 0) };
    const hash = hasher?.(core, r);
    st.selection = { ...r, monitorIndex, createdAt: core.now(), ...(hash ? { hash } : {}) };
    st.drawing = false;
  } else if (e.kind === "user.selection.plan") {
    st.plannedSelection = { x: Number(d.x ?? 0), y: Number(d.y ?? 0), w: Number(d.w ?? 0), h: Number(d.h ?? 0), monitorIndex: typeof d.monitorIndex === "number" ? d.monitorIndex : 0, afterMs: Number(d.afterMs ?? 1000) };
  } else if (e.kind === "user.selection.cancel") {
    st.drawing = false;
    st.selection = null;
  } else if (e.kind === "user.input" || e.kind === "user.mouse" || e.kind === "user.keyboard") {
    st.ownerInputAt = core.now();
  } else if (e.kind === "user.gsi") {
    st.gsi.set(String(d.source ?? "default"), { data: d.data, at: core.now() });
  }
}

export function guiState(core: DesktopCore): GuiState {
  let st = states.get(core);
  if (!st || st.epoch !== core.effects) {
    st = fresh(core);
    states.set(core, st);
  }
  if (!wired.has(core)) {
    wired.add(core);
    core.listeners.add((e) => onUserEvent(core, e));
  }
  return st;
}

/** Окна сверху вниз: переданный передний план — первый, дальше по недавности подъёма, нетронутые — от новых к старым. */
export function zOrder(core: DesktopCore, st: GuiState): DesktopWindow[] {
  const known = st.z.filter((h) => core.windows.has(h));
  const rest = [...core.windows.keys()].filter((h) => !known.includes(h)).reverse();
  let hs = [...known, ...rest];
  if (core.foreground !== null && core.windows.has(core.foreground)) hs = [core.foreground, ...hs.filter((h) => h !== core.foreground)];
  return hs.map((h) => core.windows.get(h)!);
}

/** Поднять окно наверх и сделать передним планом (свёрнутое — восстановить, как SW_RESTORE). */
export function raise(core: DesktopCore, st: GuiState, w: DesktopWindow): void {
  st.z = [w.hwnd, ...zOrder(core, st).map((x) => x.hwnd).filter((h) => h !== w.hwnd)];
  w.minimized = false;
  core.foreground = w.hwnd;
}

/** Убрать окно; передний план переходит к следующему видимому. */
export function dropWindow(core: DesktopCore, st: GuiState, w: DesktopWindow): void {
  core.windows.delete(w.hwnd);
  st.z = st.z.filter((h) => h !== w.hwnd);
  if (core.foreground === w.hwnd) core.foreground = zOrder(core, st).find((x) => !x.minimized)?.hwnd ?? null;
}

/** Окно переднего плана (или undefined, если фокуса нет / оно свёрнуто). */
export function foregroundWindow(core: DesktopCore): DesktopWindow | undefined {
  const w = core.foreground === null ? undefined : core.windows.get(core.foreground);
  return w && !w.minimized ? w : undefined;
}

export function monitorIndexOf(core: DesktopCore, w: DesktopWindow): number {
  const byId = core.monitors.findIndex((m) => m.id === w.monitor);
  const cx = w.rect.x + w.rect.w / 2;
  const cy = w.rect.y + w.rect.h / 2;
  const byRect = core.monitors.findIndex((m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h);
  return byRect >= 0 ? byRect : Math.max(0, byId);
}

/** Монитор под экранной точкой (вне всех — основной). */
export function monitorAt(core: DesktopCore, x: number, y: number): number {
  const i = core.monitors.findIndex((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
  return i >= 0 ? i : Math.max(0, core.monitors.findIndex((m) => m.primary));
}

export const monitorLabel = (core: DesktopCore, index: number): string => (core.monitors[index]?.primary ? "осн. монитор" : `монитор ${index + 1}`);

/** Виртуальное время идёт от действий: запуск, печать и клики занимают время, как у настоящего клиента. */
export const tick = (core: DesktopCore, ms: number): void => core.advance(ms);
