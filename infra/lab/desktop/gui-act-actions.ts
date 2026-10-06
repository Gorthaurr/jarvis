import type { Found } from "./gui-act-find.js";
import type { ActCmd } from "./gui-act.js";
import { center, invokeNode, mouse, physicalClick } from "./gui-click.js";
import type { Scope } from "./gui-guard.js";
import { pressKey, typeText } from "./gui-input.js";
import type { Ctx } from "./gui-model.js";
import { ActionError } from "./gui-state.js";
export interface Done {
  did: string;
  physical: boolean;
  screenX?: number;
  screenY?: number;
}

export const pointOf = (f: Found): { x: number; y: number } | undefined => f.point ?? (f.bbox ? center(f.bbox) : undefined);
export const small = (f: Found): boolean => !f.point || (f.bbox !== undefined && f.bbox.w <= 240 && f.bbox.h <= 60);

/** Клик физически (правый/двойной — только так). Цель, найденная ТОЧКОЙ, кликается в эту точку; по handle — центр элемента. */
export function physical(ctx: Ctx, f: Found, scope: Scope, button: "left" | "right" | "middle", count: number, word: string): Done {
  const p = pointOf(f);
  if (!p) throw new ActionError(`«${f.name}»: ни handle, ни точки — кликнуть физически нечем`, "runtime");
  physicalClick(ctx, p, button, count, scope);
  return { did: `${word} по «${f.name}»`, screenX: p.x, screenY: p.y, physical: true };
}

export async function doVerb(ctx: Ctx, f: Found | undefined, cmd: ActCmd, scope: Scope, findTo: (to: NonNullable<ActCmd["to"]>) => Found): Promise<Done> {
  const verb = cmd.do ?? "click";
  const text = cmd.text;
  if (verb === "key") {
    pressKey(ctx, cmd.combo!, "press", scope);
    return { did: `нажал «${cmd.combo}»`, physical: true };
  }
  if (verb === "type" && !f) {
    typeText(ctx, text!, scope);
    if (cmd.enter === true) pressKey(ctx, "Enter", "press", scope);
    return { did: `набрал «${text!.slice(0, 40)}» в поле с фокусом${cmd.enter === true ? " и нажал Enter" : ""}`, physical: true };
  }
  if (!f) throw new ActionError(`do:${verb} без цели (target)`, "runtime");
  const fromNode = f.node;
  const node = fromNode && f.w ? { w: f.w, n: fromNode } : undefined;
  switch (verb) {
    case "click": {
      if (node && f.handle && cmd.physical !== true && small(f)) {
        try {
          invokeNode(ctx, node.w, node.n, "invoke", scope);
          return { did: `UIA invoke «${f.name}»`, physical: false };
        } catch (e) {
          if (e instanceof ActionError && (e.code === "denied" || e.code === "overlay_drawing")) throw e;
          const r = physical(ctx, f, scope, "left", 1, "физический клик");
          return { ...r, did: `${r.did} (UIA invoke не поддержан: ${(e as Error).message.slice(0, 80)})` };
        }
      }
      return physical(ctx, f, scope, "left", 1, "физический клик");
    }
    case "double":
      return physical(ctx, f, scope, "left", 2, "двойной клик");
    case "triple":
      return physical(ctx, f, scope, "left", 3, "тройной клик");
    case "right":
      return physical(ctx, f, scope, "right", 1, "правый клик");
    case "middle":
      return physical(ctx, f, scope, "middle", 1, "средний клик");
    case "type": {
      const r = physical(ctx, f, scope, "left", 1, "клик");
      try {
        if (cmd.clear === true) {
          pressKey(ctx, "Ctrl+A", "press", scope);
          pressKey(ctx, "Backspace", "press", scope);
        }
        typeText(ctx, text!, scope);
        if (cmd.enter === true) pressKey(ctx, "Enter", "press", scope);
      } catch (e) {
        // Клик в поле уже ушёл: ошибка дальше — «часть действия ушла», повторять вслепую нельзя.
        if (e instanceof ActionError) throw new ActionError(e.message, e.code, e.data, true);
        throw e;
      }
      return { ...r, did: `клик в «${f.name}» и печать «${text!.slice(0, 40)}»${cmd.enter === true ? " + Enter" : ""}` };
    }
    case "set":
    case "toggle":
    case "select":
    case "expand": {
      if (!node || !f.handle) throw new ActionError(`«${f.name}»: для ${verb === "set" ? "setValue" : verb} нужен UIA-элемент (handle), а найдена только точка на экране`, "runtime");
      invokeNode(ctx, node.w, node.n, verb === "set" ? "setValue" : verb, scope, verb === "set" ? text : undefined);
      return { did: verb === "set" ? `установил значение «${(text ?? "").slice(0, 40)}» в «${f.name}»` : `${verb} «${f.name}»`, physical: false };
    }
    case "hover": {
      const p = pointOf(f)!;
      mouse(ctx, { op: "move", x: p.x, y: p.y, space: "screen" }, scope);
      return { did: `навёл курсор на «${f.name}»`, screenX: p.x, screenY: p.y, physical: true };
    }
    case "drag": {
      const p = pointOf(f)!;
      const t = pointOf(findTo(cmd.to!));
      if (!t) throw new ActionError("drag: у конечной цели нет точки", "runtime");
      mouse(ctx, { op: "drag", x: p.x, y: p.y, toX: t.x, toY: t.y, space: "screen" }, scope);
      return { did: `перетащил «${f.name}»`, screenX: p.x, screenY: p.y, physical: true };
    }
    case "scroll": {
      const p = pointOf(f)!;
      mouse(ctx, { op: "wheel", x: p.x, y: p.y, dx: cmd.dx, dy: cmd.dy, space: "screen" }, scope);
      return { did: `прокрутил над «${f.name}» (dx=${cmd.dx ?? 0}, dy=${cmd.dy ?? 0})`, screenX: p.x, screenY: p.y, physical: true };
    }
    default: {
      const never: never = verb;
      throw new ActionError(`неизвестный глагол act: ${String(never)}`, "runtime");
    }
  }
}
