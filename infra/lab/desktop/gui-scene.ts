/**
 * Сцена «экрана» FakeDesktop: рисуем окна прямоугольниками (png.ts) и отдаём то, что «прочитал бы OCR» — строки видимого
 * текста с рамками, с учётом перекрытия окон. Одна сцена питает screen.capture, screen.ocr, screen.probe и wait.for{text}.
 */
import type { DesktopCore } from "./core.js";
import { Canvas, type Rgb } from "./png.js";
import type { Ctx, Rect, UiaNode } from "./gui-model.js";
import { ActionError, type GuiState, monitorAt, setSelectionHasher } from "./gui-state.js";
import { treeOf, visibleWindows } from "./gui-tree.js";
import { makeCtx } from "./gui-apps.js";

export const CHAR_W = 8;
export const LINE_H = 18;
const TASKBAR_H = 40;

export interface SceneLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const monitorRect = (core: DesktopCore, i: number): Rect => {
  const m = core.monitors[i] ?? core.monitors[0]!;
  return { x: m.x, y: m.y, w: m.w, h: m.h };
};

/** Монитор Джарвиса: назначенный, иначе вторичный, иначе основной; временный target «primary» — основной. */
export function jarvisIndex(core: DesktopCore, st: GuiState): number {
  const primary = Math.max(0, core.monitors.findIndex((m) => m.primary));
  if (st.monitorTarget === "primary") return primary;
  if (st.jarvisMonitor !== null && core.monitors[st.jarvisMonitor]) return st.jarvisMonitor;
  const other = core.monitors.findIndex((m) => !m.primary);
  return other >= 0 ? other : primary;
}

/** Монитор по аргументу screen.*: "active" (под курсором, деф.) | "primary" | "jarvis" | индекс. Нет такого — честная ошибка. */
export function pickMonitor(ctx: Ctx, which: string | number | undefined): number {
  const { core, st } = ctx;
  if (which === undefined || which === "active") return monitorAt(core, st.cursor.x, st.cursor.y);
  if (which === "primary") return Math.max(0, core.monitors.findIndex((m) => m.primary));
  if (which === "jarvis") return jarvisIndex(core, st);
  const n = typeof which === "number" ? which : /^\d+$/u.test(which) ? Number(which) : -1;
  if (n < 0 || n >= core.monitors.length) throw new ActionError(`монитора «${String(which)}» нет (всего ${core.monitors.length}) — посмотри monitor_list`, "runtime");
  return n;
}

/** Видимый текст узла (то, что нарисовано на экране): label > значение поля > имя; контейнеры без текста молчат. */
function textOf(n: UiaNode): string {
  if (n.label !== undefined) return n.label;
  if (n.role === "edit" || n.role === "document") return n.value ?? "";
  return n.role === "pane" || n.role === "list" ? "" : n.name;
}

function nodeLines(n: UiaNode): SceneLine[] {
  const t = textOf(n);
  if (!t) return [];
  if (n.role === "edit" || n.role === "document") {
    return t.split("\n").flatMap((l, i) => (l && 4 + (i + 1) * LINE_H <= n.h + LINE_H ? [{ text: l, x: n.x + 6, y: n.y + 4 + i * LINE_H, w: Math.min(l.length * CHAR_W, n.w - 12), h: LINE_H }] : []));
  }
  const w = Math.min(t.length * CHAR_W, n.w);
  return [{ text: t, x: n.x + (n.w - w) / 2, y: n.y + (n.h - LINE_H) / 2, w, h: LINE_H }];
}

/** Строки видимого текста в области (координаты экрана): центр строки в области и не закрыт окном выше. */
export function sceneLines(ctx: Ctx, region: Rect): SceneLine[] {
  const wins = visibleWindows(ctx);
  const out: SceneLine[] = [];
  wins.forEach((w, i) => {
    const above = wins.slice(0, i);
    const lines = [{ text: w.title, x: w.rect.x + 10, y: w.rect.y + 7, w: Math.min(w.title.length * CHAR_W, w.rect.w - 160), h: LINE_H }, ...treeOf(ctx, w).flatMap(nodeLines)];
    for (const l of lines) {
      const cx = l.x + l.w / 2;
      const cy = l.y + l.h / 2;
      const inRegion = cx >= region.x && cx < region.x + region.w && cy >= region.y && cy < region.y + region.h;
      const inWin = cx >= w.rect.x && cx < w.rect.x + w.rect.w && cy >= w.rect.y && cy < w.rect.y + w.rect.h;
      const covered = above.some((a) => cx >= a.rect.x && cx < a.rect.x + a.rect.w && cy >= a.rect.y && cy < a.rect.y + a.rect.h);
      if (inRegion && inWin && !covered) out.push({ ...l, x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w) });
    }
  });
  return out;
}

const BG: Rgb = [30, 60, 110];
const FILL: Record<string, Rgb> = { button: [225, 225, 225], menuitem: [235, 235, 235], tabitem: [215, 225, 240], listitem: [245, 245, 250], edit: [255, 255, 255], document: [255, 255, 255] };

/** Нарисовать область экрана (координаты экрана) в холст W×H. */
export function render(ctx: Ctx, region: Rect, W: number, H: number): Canvas {
  const { core, st } = ctx;
  const c = new Canvas(W, H, BG);
  const sx = W / region.w;
  const sy = H / region.h;
  const rect = (r: Rect, col: Rgb): void => c.rect((r.x - region.x) * sx, (r.y - region.y) * sy, r.w * sx, r.h * sy, col);
  const frame = (r: Rect, col: Rgb): void => c.frame((r.x - region.x) * sx, (r.y - region.y) * sy, Math.max(2, r.w * sx), Math.max(2, r.h * sy), col);
  const px = Math.max(1, Math.round(2 * sx));
  const text = (x: number, y: number, s: string, col: Rgb, maxW: number): void => c.text((x - region.x) * sx, (y - region.y) * sy, s, px, col, maxW * sx);
  for (const m of core.monitors) if (m.primary) rect({ x: m.x, y: m.y + m.h - TASKBAR_H, w: m.w, h: TASKBAR_H }, [20, 20, 24]);
  const wins = visibleWindows(ctx);
  for (const w of [...wins].reverse()) {
    const fg = core.foreground === w.hwnd;
    rect(w.rect, [240, 240, 240]);
    frame(w.rect, fg ? [0, 120, 215] : [140, 140, 140]);
    rect({ x: w.rect.x, y: w.rect.y, w: w.rect.w, h: 32 }, fg ? [0, 120, 215] : [190, 190, 190]);
    text(w.rect.x + 10, w.rect.y + 7, w.title, fg ? [255, 255, 255] : [30, 30, 30], w.rect.w - 160);
    for (const n of treeOf(ctx, w)) {
      const f = FILL[n.role];
      if (f && n.interactive) {
        rect(n, f);
        frame(n, [160, 160, 160]);
      }
      for (const l of nodeLines(n)) text(l.x, l.y, l.text, [20, 20, 20], l.w);
    }
  }
  rect({ x: st.cursor.x - 2, y: st.cursor.y - 2, w: 8, h: 8 }, [255, 255, 255]);
  return c;
}

/** Размер картинки: множитель к нативу, затем кап по длинной стороне и числу пикселей (только вниз), как у fitSize клиента. */
export function fitSize(w: number, h: number, factor: number, cap: { maxEdge: number; maxPixels: number }): { w: number; h: number } {
  const tw = w * factor;
  const th = h * factor;
  const s = Math.min(1, cap.maxEdge / Math.max(tw, th), Math.sqrt(cap.maxPixels / (tw * th)));
  return { w: Math.max(1, Math.round(tw * s)), h: Math.max(1, Math.round(th * s)) };
}

// Отпечаток выделения снимается в момент события «владелец обвёл» — тем же путём, что и screen.probe.
setSelectionHasher((core, r) => {
  const ctx = makeCtx(core);
  const s = fitSize(r.w, r.h, 1, { maxEdge: 256, maxPixels: 65_536 });
  return render(ctx, r, s.w, s.h).probe().hash;
});
