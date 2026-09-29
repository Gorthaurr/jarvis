/**
 * Зрение FakeDesktop: screen.capture (настоящий PNG сцены + frameId), screen.ocr (строки видимого текста), screen.probe
 * (перцептивный хеш), screen.selection (режим выделения «вот тут»), мониторы и wait.for. Координаты модели — только в кадре.
 */
import type { DesktopCore, KindHandler, KindHandlers } from "./core.js";
import { type Frame, registerFrame } from "./gui-state.js";
import { fitSize, jarvisIndex, monitorRect, pickMonitor, render, sceneLines } from "./gui-scene.js";
import type { Ctx, Rect } from "./gui-model.js";
import { guarded } from "./gui-run.js";
import { ActionError, monitorAt, toScreenRect } from "./gui-state.js";
import { makeWaiter } from "./gui-wait.js";

const STD = { maxEdge: 1568, maxPixels: 1_150_000 };
const FRESH_MS = 5000;
const MAX_WAIT = 120_000;

interface Region {
  monitor: number;
  rect: Rect;
  from?: Frame;
}

/** Монитор или регион (в кадре/space:"screen"): регион режется по границам монитора; вне монитора — честная ошибка. */
function region(ctx: Ctx, which: string | number | undefined, r: (Rect & { space?: "screen"; frame?: string }) | undefined): Region {
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

interface Shot {
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

function probeOf(ctx: Ctx, r: Rect): { hash: string; mean: number; width: number; height: number } {
  const s = fitSize(r.w, r.h, 1, { maxEdge: 256, maxPixels: 65_536 });
  return { ...render(ctx, r, s.w, s.h).probe(), width: s.w, height: s.h };
}

const tagsOf = (core: DesktopCore, i: number): string => {
  const m = core.monitors[i]!;
  const p = core.monitors.find((x) => x.primary) ?? m;
  if (m.primary) return "основной";
  return m.x < p.x ? "слева" : m.x > p.x ? "справа" : m.y < p.y ? "сверху" : "снизу";
};

function monitorList(ctx: Ctx): { monitors: Array<Record<string, unknown>>; jarvisIndex: number | null } {
  const { core, st } = ctx;
  const j = jarvisIndex(core, st);
  return {
    monitors: core.monitors.map((m, i) => ({ index: i, label: `Монитор ${i + 1} — ${m.w}×${m.h} (${tagsOf(core, i)})`, width: m.w, height: m.h, isPrimary: m.primary, isJarvis: i === j })),
    jarvisIndex: st.jarvisMonitor,
  };
}

export function screenHandlers(core: DesktopCore, dispatch: KindHandler): KindHandlers {
  const waitFor = makeWaiter(dispatch);
  return {
    "screen.capture": guarded<"screen.capture">(core, (cmd, ctx) =>
      capture(ctx, region(ctx, cmd.monitor, cmd.rect), cmd.rect ? "z" : "f", { scale: cmd.scale, maxEdge: cmd.maxEdge, maxPixels: cmd.maxPixels }),
    ),

    "screen.ocr": guarded<"screen.ocr">(core, (cmd, ctx) => {
      const rg = region(ctx, cmd.monitor, cmd.rect);
      const o = registerFrame(ctx.st, { kind: "o", monitor: rg.monitor, origin: { x: rg.rect.x, y: rg.rect.y }, sx: 1, sy: 1, w: Math.round(rg.rect.w), h: Math.round(rg.rect.h) });
      const task = cmd.frame ? ctx.st.frames.get(cmd.frame) : undefined;
      const inTask = task && task.monitor === rg.monitor ? task : undefined;
      const sys = inTask ?? o;
      const lines = sceneLines(ctx, rg.rect)
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((l) => ({ text: l.text, x: Math.round((l.x - sys.origin.x) * sys.sx), y: Math.round((l.y - sys.origin.y) * sys.sy), w: Math.round(l.w * sys.sx), h: Math.round(l.h * sys.sy) }));
      return {
        text: lines.map((l) => l.text).join("\n"),
        lines,
        width: sys.w,
        height: sys.h,
        frameId: o.id,
        ...(inTask ? { frame: inTask.id } : {}),
        mapping: { boundsX: sys.origin.x, boundsY: sys.origin.y, scale: sys.sx },
      };
    }),

    "screen.probe": guarded<"screen.probe">(core, (cmd, ctx) => probeOf(ctx, region(ctx, cmd.monitor, cmd.rect).rect)),

    "screen.selection": guarded<"screen.selection">(core, (cmd, ctx) => {
      const { st } = ctx;
      if (cmd.op === "clear") {
        const out = { cleared: st.selection !== null, drawCancelled: st.drawing };
        st.selection = null;
        st.drawing = false;
        return out;
      }
      if (cmd.op === "view") {
        if (st.drawing) throw new ActionError('Сейчас идёт рисование: на экране вуаль режима выделения, область ещё не зафиксирована. Дождись исхода (screen_selection{op:"start", waitMs}) или спроси владельца — смотреть пока нечего.', "overlay_drawing");
        const sel = st.selection;
        if (!sel) throw new ActionError('Владелец сейчас ничего не выделял на экране. Попроси обвести область (screen_selection{op:"start"} или горячая клавиша) либо смотри экран обычным screen_capture.', "runtime");
        const shot = capture(ctx, { monitor: sel.monitorIndex, rect: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } }, "s", { scale: cmd.scale });
        const unscaled = cmd.scale === undefined || cmd.scale === 1;
        const changed = sel.hash && unscaled ? { changedSinceSelection: probeOf(ctx, sel).hash !== sel.hash } : {};
        return { image: shot.image, mediaType: shot.mediaType, width: shot.width, height: shot.height, selection: { ...sel }, ageMs: core.now() - sel.createdAt, frameId: shot.frameId, ...changed };
      }
      // start
      const fresh = st.selection && core.now() - st.selection.createdAt < FRESH_MS && !st.drawing;
      if (!cmd.force && fresh) return { started: false, reused: true, selection: { ...st.selection! } };
      st.drawing = true;
      const wait = Math.max(0, Math.min(MAX_WAIT, typeof cmd.waitMs === "number" && Number.isFinite(cmd.waitMs) ? cmd.waitMs : 0));
      if (wait <= 0) return { started: true, waiting: true };
      const plan = st.plannedSelection;
      if (plan && plan.afterMs <= wait) {
        core.advance(plan.afterMs);
        st.plannedSelection = null;
        core.effect("user.selection", { x: plan.x, y: plan.y, w: plan.w, h: plan.h, monitorIndex: plan.monitorIndex, planned: true });
        return { started: true, selection: { ...st.selection! }, waitedMs: plan.afterMs };
      }
      core.advance(wait); // владелец не обвёл за отведённое время — честный таймаут
      return { started: true, timedOut: true, overlayOpen: st.drawing, waitedMs: wait };
    }),

    "wait.for": guarded<"wait.for">(core, (cmd, ctx) => waitFor(ctx, cmd.condition, cmd.timeoutMs, cmd.pollMs)),

    "monitor.set": guarded<"monitor.set">(core, (cmd, ctx) => {
      ctx.st.monitorTarget = cmd.target;
      const primary = core.monitors[jarvisIndex(core, ctx.st)]?.primary ?? true;
      return { target: cmd.target, summary: `мониторов: ${core.monitors.length}; Джарвис на ${primary ? "основном" : "вторичном"}; цель: ${cmd.target}` };
    }),

    "monitor.list": guarded<"monitor.list">(core, (_cmd, ctx) => monitorList(ctx)),

    "monitor.assign": guarded<"monitor.assign">(core, (cmd, ctx) => {
      if (cmd.index !== null && (cmd.index < 0 || cmd.index >= core.monitors.length)) {
        throw new ActionError(`нет монитора с номером ${cmd.index + 1} — всего мониторов ${core.monitors.length}`, "runtime");
      }
      ctx.st.jarvisMonitor = cmd.index;
      core.effect("monitor.assign", { index: cmd.index });
      return monitorList(ctx);
    }),

    // Настоящий клиент отвечает так же: запись показом идёт мимо протокола (M4). Лаборатория не делает вид, что умеет.
    "demo.record": guarded<"demo.record">(core, () => {
      throw new ActionError("not implemented (M4)", "runtime");
    }),
  };
}
