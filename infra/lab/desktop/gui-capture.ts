import type { DesktopCore } from "./core.js";
import type { Ctx, Rect } from "./gui-model.js";
import { fitSize, jarvisIndex, monitorRect, pickMonitor, render } from "./gui-scene.js";
import { ActionError, type Frame, monitorAt, registerFrame, toScreenRect } from "./gui-state.js";
export const STD = { maxEdge: 1568, maxPixels: 1_150_000 };

export interface Region {
  monitor: number;
  rect: Rect;
  from?: Frame;
}

/** Монитор или регион (в кадре/space:"screen"): регион режется по границам монитора; вне монитора — честная ошибка. */
export function region(ctx: Ctx, which: string | number | undefined, r: (Rect & { space?: "screen"; frame?: string }) | undefined): Region {
  const { core, st } = ctx;
  if (!r) {
    const monitor = pickMonitor(ctx, which);
    return { monitor, rect: monitorRect(core, monitor) };
  }
  const { rect, from } = toScreenRect(st, r);
  const monitor = from ? from.monitor : which !== undefined ? pickMonitor(ctx, which) : monitorAt(core, rect.x + rect.w / 2, rect.y + rect.h / 2);
  const m = monitorRect(core, monitor);
  const x0 = Math.max(rect.x, m.x);
  const y0 = Math.max(rect.y, m.y);
  const x1 = Math.min(rect.x + rect.w, m.x + m.w);
  const y1 = Math.min(rect.y + rect.h, m.y + m.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) throw new ActionError("регион вне монитора — снимать нечего; проверь координаты и кадр", "runtime");
  return { monitor, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, ...(from ? { from } : {}) };
}

export interface Shot {
  image: string;
  mediaType: "image/png";
  width: number;
  height: number;
  frameId: string;
  zoomOf?: string;
}

/** Снять регион в картинку и зарегистрировать кадр (kind: f полный, z зум, s выделение). */
export function capture(ctx: Ctx, rg: Region, kind: "f" | "z" | "s", o: { scale?: number; maxEdge?: number; maxPixels?: number }): Shot {
  const zoomDefault = kind === "z" && rg.from && rg.from.sx >= 0.99 ? 2 : 1;
  const factor = o.scale !== undefined ? Math.max(0.25, Math.min(2, o.scale)) : zoomDefault;
  const size = fitSize(rg.rect.w, rg.rect.h, factor, { maxEdge: o.maxEdge ?? STD.maxEdge, maxPixels: o.maxPixels ?? STD.maxPixels });
  const png = render(ctx, rg.rect, size.w, size.h).toPng();
  const f = registerFrame(ctx.st, { kind, monitor: rg.monitor, origin: { x: rg.rect.x, y: rg.rect.y }, sx: size.w / rg.rect.w, sy: size.h / rg.rect.h, w: size.w, h: size.h, ...(rg.from ? { zoomOf: rg.from.id } : {}) });
  ctx.core.effect("screen.capture", { monitor: rg.monitor, frameId: f.id, kind });
  return { image: png.toString("base64"), mediaType: "image/png", width: size.w, height: size.h, frameId: f.id, ...(rg.from ? { zoomOf: rg.from.id } : {}) };
}

export function probeOf(ctx: Ctx, r: Rect): { hash: string; mean: number; width: number; height: number } {
  const s = fitSize(r.w, r.h, 1, { maxEdge: 256, maxPixels: 65_536 });
  return { ...render(ctx, r, s.w, s.h).probe(), width: s.w, height: s.h };
}

export const tagsOf = (core: DesktopCore, i: number): string => {
  const m = core.monitors[i]!;
  const p = core.monitors.find((x) => x.primary) ?? m;
  if (m.primary) return "основной";
  return m.x < p.x ? "слева" : m.x > p.x ? "справа" : m.y < p.y ? "сверху" : "снизу";
};

export function monitorList(ctx: Ctx): { monitors: Array<Record<string, unknown>>; jarvisIndex: number | null } {
  const { core, st } = ctx;
  const j = jarvisIndex(core, st);
  return {
    monitors: core.monitors.map((m, i) => ({ index: i, label: `Монитор ${i + 1} — ${m.w}×${m.h} (${tagsOf(core, i)})`, width: m.w, height: m.h, isPrimary: m.primary, isJarvis: i === j })),
    jarvisIndex: st.jarvisMonitor,
  };
}
