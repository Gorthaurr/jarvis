/**
 * UIA-команды: ui.ground / ui.snapshot / ui.invoke / context.read. Формы data — из Ipc.cs и ground.ts настоящего клиента:
 * ground → {handle (строка), bbox, name, role:"ControlType.X"}, snapshot → items с handle ЧИСЛОМ и коротким role.
 */
import type { KindHandlers, DesktopCore } from "./core.js";
import { invokeNode, resolveTarget } from "./gui-click.js";
import { scopeOf } from "./gui-guard.js";
import { guarded } from "./gui-run.js";
import { ActionError, foregroundWindow, getFrame } from "./gui-state.js";
import { controlType, digestLines, fingerprint, findNode, observe, treeOf, visibleWindows } from "./gui-tree.js";

const SNAPSHOT_DEFAULT = 200;

export function uiaHandlers(core: DesktopCore): KindHandlers {
  return {
    "ui.ground": guarded<"ui.ground">(core, (cmd, ctx) => {
      const { node } = findNode(ctx, cmd.query);
      return { handle: String(node.handle), bbox: { x: node.x, y: node.y, w: node.w, h: node.h }, name: node.name, role: controlType(node.role) };
    }),

    "ui.snapshot": guarded<"ui.snapshot">(core, (cmd, ctx) => {
      const w = cmd.pid !== undefined ? visibleWindows(ctx).find((x) => x.pid === cmd.pid) : foregroundWindow(core);
      if (!w) return { window: "", pid: cmd.pid ?? 0, items: [], truncated: false, ...(cmd.frame ? { frame: cmd.frame } : {}) };
      const max = Math.max(1, cmd.maxItems ?? SNAPSHOT_DEFAULT);
      const all = treeOf(ctx, w).filter((n) => n.interactive);
      // Рамка bbox: в кадре задачи (пиксели картинки) — модель сверяет с тем, что видела; устаревший кадр — not_found.
      const f = cmd.frame ? getFrame(ctx.st, cmd.frame) : undefined;
      const box = (n: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } =>
        f ? { x: Math.round((n.x - f.origin.x) * f.sx), y: Math.round((n.y - f.origin.y) * f.sy), w: Math.round(n.w * f.sx), h: Math.round(n.h * f.sy) } : { x: n.x, y: n.y, w: n.w, h: n.h };
      return {
        window: w.title,
        pid: w.pid,
        items: all.slice(0, max).map((n) => ({ handle: n.handle, role: n.role, name: n.name, automationId: n.automationId ?? null, value: n.value ?? null, ...box(n) })),
        truncated: all.length > max,
        ...(f ? { frame: f.id } : {}),
      };
    }),

    "ui.invoke": guarded<"ui.invoke">(core, (cmd, ctx) => {
      if (cmd.pattern === "setValue" && (cmd.value === undefined || cmd.value === "")) {
        throw new ActionError("ui.invoke setValue без значения — отказ (для очистки поля передай явное пустое намерение)", "runtime");
      }
      if (cmd.target.by === "coords") throw new ActionError("ui.invoke по координатам невозможен — нужен a11y-handle", "runtime");
      const r = resolveTarget(ctx, cmd.target);
      const before = fingerprint(ctx, r.w);
      invokeNode(ctx, r.w!, r.node!, cmd.pattern, scopeOf(cmd), cmd.value);
      const observation = observe(ctx, before);
      return observation ? { observation } : undefined;
    }),

    "context.read": guarded<"context.read">(core, (cmd, ctx) => {
      const w = foregroundWindow(core);
      if (!w) return { scope: cmd.scope, text: "" };
      const text = cmd.scope === "selection" ? ctx.model(w).selectedText() : digestLines(ctx, w).join("\n");
      return { scope: cmd.scope, text };
    }),
  };
}
