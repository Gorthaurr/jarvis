/**
 * W2 П5: bbox элементов `look{elements}` (ui.snapshot) — в СИСТЕМЕ КАДРА задачи.
 *
 * Сайдкар отдаёт bbox в ФИЗИЧЕСКИХ пикселях UIA; модель видит картинку кадра (копию, ужатую под её зрение) — прямой
 * act{x,y} по физическому bbox промахивался на любом масштабе ≠ 100 % и на любом ужатом кадре. Теперь: физика → DIP
 * (coords.physicalRectToDip) → система кадра (frames.dipRectToFrame). Кадра нет или он устарел → bbox не отдаётся
 * вовсе (действие — по handle); элемент вне картинки кадра (другой монитор) — тоже без bbox: модель его не видела.
 */
import { physicalRectToDip } from "./coords.js";
import { dipRectToFrame, findFrame, rectCenterInFrame } from "./frames.js";
import type { UiSnapshot, UiSnapshotItem } from "./ground.js";

type OutItem = Omit<UiSnapshotItem, "x" | "y" | "w" | "h"> & Partial<Pick<UiSnapshotItem, "x" | "y" | "w" | "h">>;

/** Снапшот для модели: bbox — в кадре `frame` (целые px) или без bbox. Внутренний снапшот (act, зеркало) не трогается. */
export function snapshotInFrame(snap: UiSnapshot, frame?: string): Omit<UiSnapshot, "items"> & { items: OutItem[]; frame?: string } {
  const f = findFrame(frame);
  const items = snap.items.map((it): OutItem => {
    const { x, y, w, h, ...rest } = it;
    if (!f || ![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) || w <= 0 || h <= 0) return rest;
    const r = dipRectToFrame(f, physicalRectToDip({ x, y, w, h }));
    if (!rectCenterInFrame(f, r)) return rest;
    return { ...rest, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  });
  return { ...snap, items, ...(f ? { frame: f.id } : {}) };
}
