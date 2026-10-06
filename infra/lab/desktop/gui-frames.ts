import { ActionError } from "./gui-errors.js";
import type { CoordSpace, Frame, GuiState, Rect } from "./gui-state-types.js";
export const FRAME_LRU_MAX = 64;

// ─────────────── кадры ───────────────

export function registerFrame(st: GuiState, m: Omit<Frame, "id">): Frame {
  st.frameSeq += 1;
  const f: Frame = { ...m, id: `lab${m.kind}${st.frameSeq}` };
  st.frames.set(f.id, f);
  while (st.frames.size > FRAME_LRU_MAX) st.frames.delete(st.frames.keys().next().value as string);
  return f;
}

/** Кадр по id (освежает LRU). Вытесненный/чужой → not_found «кадр устарел», как у настоящего клиента. */
export function getFrame(st: GuiState, id: string): Frame {
  const f = st.frames.get(id);
  if (!f) throw new ActionError(`кадр «${String(id).slice(0, 40)}» неизвестен или устарел — кадр устарел, пересними screen_capture и возьми координаты с него; ничего не нажато`, "not_found");
  st.frames.delete(id);
  st.frames.set(id, f);
  return f;
}

/** Точка модели → экранные координаты. space:"screen" главнее кадра; без обоих — честный отказ, а не догадка. */
export function toScreenPoint(st: GuiState, x: number, y: number, o: CoordSpace = {}): { x: number; y: number } {
  if (o.space === "screen") return { x, y };
  if (!o.frame) throw new ActionError("координаты без кадра: сначала screen_capture (или look{text}) и бери координаты с него; ничего не нажато", "not_found");
  const f = getFrame(st, o.frame);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1 || y < -1 || x > f.w + 1 || y > f.h + 1) {
    throw new ActionError(`точка ${x},${y} вне кадра ${f.id} (${f.w}×${f.h}) — координаты не из этого кадра; пересними и возьми их с картинки; ничего не нажато`, "not_found");
  }
  return { x: f.origin.x + x / f.sx, y: f.origin.y + y / f.sy };
}

/** Регион модели → экранный прямоугольник (та же логика, что у точки). */
export function toScreenRect(st: GuiState, r: Rect & CoordSpace): { rect: Rect; from?: Frame } {
  if (r.space === "screen") return { rect: { x: r.x, y: r.y, w: r.w, h: r.h } };
  if (!r.frame) throw new ActionError("регион без кадра: сначала screen_capture и бери координаты с него; ничего не снято", "not_found");
  const f = getFrame(st, r.frame);
  const ok = [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0 && r.x < f.w && r.y < f.h && r.x + r.w > 0 && r.y + r.h > 0;
  if (!ok) throw new ActionError(`регион ${r.x},${r.y} ${r.w}×${r.h} вне кадра ${f.id} (${f.w}×${f.h}) — координаты не из этого кадра`, "not_found");
  return { rect: { x: f.origin.x + r.x / f.sx, y: f.origin.y + r.y / f.sy, w: r.w / f.sx, h: r.h / f.sy }, from: f };
}
