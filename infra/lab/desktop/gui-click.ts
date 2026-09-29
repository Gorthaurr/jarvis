/**
 * Указательный ввод FakeDesktop: input.click (лестница «тихо → точка → физика»), input.mouse, ui.invoke. Состояние меняется
 * только через модели приложений; §14 судит рубеж (gui-guard) ДО любого изменения.
 */
import type { MouseButton, Target } from "@jarvis/protocol";
import type { DesktopWindow } from "../lib/contracts.js";
import { type Scope, judge } from "./gui-guard.js";
import { veilGate } from "./gui-input.js";
import type { Ctx, UiaNode } from "./gui-model.js";
import { ActionError, type CoordSpace, raise, tick, toScreenPoint } from "./gui-state.js";
import { findNode, hitTest, pressNode, resolveHandle } from "./gui-tree.js";

const MAX_INVOKE_W = 240;
const MAX_INVOKE_H = 60;

export interface Resolved {
  via: "handle" | "role" | "coords";
  w?: DesktopWindow;
  node?: UiaNode;
  point?: { x: number; y: number };
}

const cap = (r: string): string => r.charAt(0).toUpperCase() + r.slice(1);
export const center = (n: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({ x: Math.round(n.x + n.w / 2), y: Math.round(n.y + n.h / 2) });

export function resolveTarget(ctx: Ctx, t: Target): Resolved {
  if (t.by === "handle") return { via: "handle", ...resolveHandle(ctx, t.handle) };
  if (t.by === "role") return { via: "role", ...findNode(ctx, { role: t.role, name: t.name }) };
  const point = toScreenPoint(ctx.st, t.x, t.y, t as CoordSpace);
  const hit = hitTest(ctx, point.x, point.y);
  return { via: "coords", point, ...(hit ? { w: hit.w, ...(hit.node ? { node: hit.node } : {}) } : {}) };
}

/** UIA-паттерн по узлу (без курсора и фокуса). Неинтерактивный узел — «паттерн не поддержан» (до какого-либо действия). */
export function invokeNode(ctx: Ctx, w: DesktopWindow, node: UiaNode, pattern: string, scope: Scope, value?: string): void {
  judge(scope, [{ op: "invoke", params: { pattern }, w, element: { role: node.role, name: node.name } }]);
  if (pattern === "scroll") {
    ctx.core.effect("ui.invoke", { hwnd: w.hwnd, name: node.name, pattern });
    return;
  }
  if (!node.interactive) throw new ActionError(`UIA: паттерн ${pattern} не поддержан элементом «${node.name}» (${node.role})`, "runtime");
  if (pattern === "setValue") ctx.model(w).setValue(node.id, value ?? "");
  else pressNode(ctx, w, node, { button: "left", count: 1, invoke: true });
  ctx.core.effect("ui.invoke", { hwnd: w.hwnd, process: w.process, name: node.name, pattern, ...(pattern === "setValue" ? { value } : {}) });
  tick(ctx.core, 60);
}

/** Физический клик в точку: окно под точкой поднимается, узел под ней получает нажатие. Курсор возвращается (не меняется). */
export function physicalClick(ctx: Ctx, at: { x: number; y: number }, button: MouseButton, count: number, scope: Scope): { w?: DesktopWindow; node?: UiaNode } {
  veilGate(ctx);
  const hit = hitTest(ctx, at.x, at.y);
  judge(scope, [{ op: "click", params: { button, count }, w: hit?.w, element: hit?.node ? { role: hit.node.role, name: hit.node.name } : {} }]);
  if (hit) {
    raise(ctx.core, ctx.st, hit.w);
    if (hit.node) pressNode(ctx, hit.w, hit.node, { button, count, invoke: false });
  }
  ctx.core.effect("input.click", { ...(hit ? { hwnd: hit.w.hwnd, process: hit.w.process } : {}), x: at.x, y: at.y, button, count, ...(hit?.node ? { node: hit.node.name } : {}) });
  tick(ctx.core, 60);
  return { ...(hit?.w ? { w: hit.w } : {}), ...(hit?.node ? { node: hit.node } : {}) };
}

export interface ClickOut {
  screenX: number;
  screenY: number;
  pressed?: string;
}

export function click(ctx: Ctx, target: Target, method: "silent" | "physical", button: MouseButton, count: number, scope: Scope): ClickOut | undefined {
  const silentPossible = button === "left" && count === 1;
  if (method === "physical" || target.by === "coords" || !silentPossible) veilGate(ctx);
  const r = resolveTarget(ctx, target);
  const resolved = r.point ? { screenX: r.point.x, screenY: r.point.y } : undefined;
  let pressed: string | undefined;
  if (method !== "physical" && silentPossible) {
    try {
      if (r.via !== "coords" && r.w && r.node) return void invokeNode(ctx, r.w, r.node, "invoke", scope);
      if (r.w && r.node) {
        pressed = `${cap(r.node.role)} «${r.node.name.slice(0, 60)}»`;
        if (r.node.interactive && r.node.w <= MAX_INVOKE_W && r.node.h <= MAX_INVOKE_H) {
          invokeNode(ctx, r.w, r.node, "invoke", scope);
          return { ...resolved!, pressed };
        }
      }
    } catch (e) {
      if (e instanceof ActionError && e.code === "denied") throw e; // отказ рубежа — не повод нажать то же физически
      if (e instanceof ActionError && e.code === "overlay_drawing") throw e;
    }
  }
  const pt = r.point ?? (r.node ? center(r.node) : undefined);
  if (!pt) throw new ActionError("цель клика не найдена", "not_found");
  physicalClick(ctx, pt, button, count, scope);
  return resolved ? { ...resolved, ...(pressed ? { pressed } : {}) } : undefined;
}

export interface MouseCmd {
  op: "move" | "down" | "up" | "wheel" | "drag";
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  button?: MouseButton;
  dx?: number;
  dy?: number;
  space?: "screen";
  frame?: string;
}

export function mouse(ctx: Ctx, cmd: MouseCmd, scope: Scope): void {
  const { core, st } = ctx;
  veilGate(ctx);
  const at = cmd.x !== undefined && cmd.y !== undefined ? toScreenPoint(st, cmd.x, cmd.y, cmd) : { ...st.cursor };
  const to = cmd.toX !== undefined && cmd.toY !== undefined ? toScreenPoint(st, cmd.toX, cmd.toY, cmd) : undefined;
  const button = cmd.button ?? "left";
  const hit = hitTest(ctx, at.x, at.y);
  const el = hit?.node ? { role: hit.node.role, name: hit.node.name } : {};
  if (cmd.op === "move") st.cursor = at;
  else if (cmd.op === "down") {
    judge(scope, [{ op: "mouse", params: { op: "down", button }, w: hit?.w, element: el }]);
    st.mouseDown = { ...at, button };
  } else if (cmd.op === "up") {
    const d = st.mouseDown;
    st.mouseDown = null;
    if (d && Math.hypot(d.x - at.x, d.y - at.y) < 5) physicalClick(ctx, at, d.button as MouseButton, 1, scope);
  } else if (cmd.op === "drag") {
    if (!to) throw new ActionError("input.mouse drag без toX/toY — куда тащить", "runtime");
    judge(scope, [{ op: "mouse", params: { op: "drag", button }, w: hit?.w, element: el }]);
    st.cursor = to;
    const end = hitTest(ctx, to.x, to.y);
    core.effect("input.drag", { from: at, to, fromNode: hit?.node?.name, toNode: end?.node?.name, hwnd: hit?.w.hwnd });
  }
  core.effect("input.mouse", { op: cmd.op, x: at.x, y: at.y, ...(to ? { toX: to.x, toY: to.y } : {}), button, ...(cmd.dy !== undefined ? { dy: cmd.dy } : {}), ...(cmd.dx !== undefined ? { dx: cmd.dx } : {}) });
  tick(core, cmd.op === "drag" ? 300 : 40);
}
