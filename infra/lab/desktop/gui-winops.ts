/**
 * Операции над окнами FakeDesktop: свернуть/развернуть/восстановить/перенести/закрыть и запись window.list.
 * Одна точка правды: кнопки заголовка окна (UIA), window.arrange и app.close ходят сюда.
 */
import type { DesktopWindow } from "../lib/contracts.js";
import type { DesktopCore } from "./core.js";
import type { Ctx, Rect } from "./gui-model.js";
import { dropWindow, foregroundWindow, monitorIndexOf, monitorLabel, raise, zOrder } from "./gui-state.js";

const TASKBAR_H = 40;
const extra = new WeakMap<DesktopWindow, { prev: Rect }>();

export const isMaximized = (w: DesktopWindow): boolean => extra.has(w);

/** Рабочая область монитора (без панели задач на основном). */
export function workArea(core: DesktopCore, index: number): Rect {
  const m = core.monitors[index] ?? core.monitors[0]!;
  return { x: m.x, y: m.y, w: m.w, h: m.primary ? m.h - TASKBAR_H : m.h };
}

export function minimizeWin(ctx: Ctx, w: DesktopWindow): void {
  w.minimized = true;
  if (ctx.core.foreground === w.hwnd) ctx.core.foreground = zOrder(ctx.core, ctx.st).find((x) => !x.minimized && x !== w)?.hwnd ?? null;
  ctx.core.effect("window.minimize", { hwnd: w.hwnd, process: w.process });
}

export function maximizeWin(ctx: Ctx, w: DesktopWindow): void {
  if (!extra.has(w)) extra.set(w, { prev: { ...w.rect } });
  const wa = workArea(ctx.core, monitorIndexOf(ctx.core, w));
  w.rect = { ...wa };
  raise(ctx.core, ctx.st, w);
  ctx.core.effect("window.maximize", { hwnd: w.hwnd, process: w.process });
}

export function restoreWin(ctx: Ctx, w: DesktopWindow): void {
  const prev = extra.get(w)?.prev;
  if (prev) {
    w.rect = { ...prev };
    extra.delete(w);
  }
  raise(ctx.core, ctx.st, w);
  ctx.core.effect("window.restore", { hwnd: w.hwnd, process: w.process });
}

/** Перенос на монитор с сохранением размера (не шире рабочей области); maximizeAfter — на весь монитор. */
export function moveWin(ctx: Ctx, w: DesktopWindow, monitor: number, maximizeAfter = false): void {
  const m = ctx.core.monitors[monitor];
  if (!m) throw new Error(`монитора с индексом ${monitor} нет (всего ${ctx.core.monitors.length}) — посмотри monitor_list`);
  extra.delete(w);
  const wa = workArea(ctx.core, monitor);
  const ww = Math.min(w.rect.w, wa.w);
  const hh = Math.min(w.rect.h, wa.h);
  w.rect = { x: wa.x + Math.round((wa.w - ww) / 2), y: wa.y + Math.round((wa.h - hh) / 2), w: ww, h: hh };
  w.monitor = m.id;
  w.minimized = false;
  ctx.core.effect("window.move", { hwnd: w.hwnd, process: w.process, monitor });
  if (maximizeAfter) maximizeWin(ctx, w);
}

/**
 * Закрыть окно как «крестик»/CloseMainWindow: приложение может отказать (несохранённый блокнот спросит «Сохранить?»).
 * true — окно ушло, false — осталось (честный исход для app.close: closed=0). force — жёсткий kill, без вопросов.
 */
export function closeWin(ctx: Ctx, w: DesktopWindow, force = false, via = "close"): boolean {
  const m = ctx.model(w);
  if (!force && m.canClose && !m.canClose()) {
    ctx.core.effect("window.close.blocked", { hwnd: w.hwnd, process: w.process, via });
    return false;
  }
  dropWindow(ctx.core, ctx.st, w);
  ctx.core.effect("window.close", { hwnd: w.hwnd, pid: w.pid, process: w.process, via, force });
  return true;
}

/** Запись window.list (форма настоящего актуатора: monitorIndex 0-based, метка, rect). */
export function windowInfo(ctx: Ctx, w: DesktopWindow): Record<string, unknown> {
  const idx = monitorIndexOf(ctx.core, w);
  return {
    hwnd: w.hwnd,
    pid: w.pid,
    process: w.process,
    title: w.title,
    foreground: foregroundWindow(ctx.core)?.hwnd === w.hwnd,
    minimized: w.minimized,
    monitorIndex: w.minimized ? 0 : idx,
    monitor: w.minimized ? "свёрнуто" : ctx.core.monitors.length > 1 ? monitorLabel(ctx.core, idx) : "осн. монитор",
    rect: { ...w.rect },
  };
}
