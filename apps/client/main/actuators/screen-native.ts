/**
 * W2 П5 (G-4, G-6): захват монитора в НАТИВНОМ разрешении и геометрия региона.
 *
 * Раньше миниатюра запрашивалась сразу ≤ 1568 px — зум и OCR резали уже пережатую картинку: мелкий текст на 4K
 * исчезал до OCR, а «лупа» увеличивала мыло. Теперь thumbnailSize = размер монитора × scaleFactor (натив), копия для
 * модели ужимается отдельно (fitSize), зум и OCR режут натив.
 *
 * Масштаб — по РЕАЛЬНОМУ getSize() картинки, а не по запрошенному: под масштабом 150 % desktopCapturer отдаёт
 * 2559×1439 вместо 2560×1440 (проверено под Xvfb), а на слабом железе/удалённом столе — и вовсе меньше запрошенного.
 */
import { type Display, type NativeImage, desktopCapturer } from "electron";
import type { Rect } from "./frames.js";

export interface NativeShot {
  img: NativeImage;
  /** Реальный размер картинки (px). */
  w: number;
  h: number;
  /** Пикселей натива на DIP по осям. */
  sx: number;
  sy: number;
  display: Display;
}

export interface VisionCapLike {
  maxEdge?: number;
  maxPixels?: number;
}

/** Снять монитор в нативном разрешении. */
export async function grabNative(display: Display): Promise<NativeShot> {
  const b = display.bounds;
  const sf = display.scaleFactor > 0 ? display.scaleFactor : 1;
  const thumbnailSize = { width: Math.max(1, Math.round(b.width * sf)), height: Math.max(1, Math.round(b.height * sf)) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  if (sources.length === 0) throw new Error("нет источников экрана для захвата");
  // Источник выбранного монитора по display_id; иначе — первый доступный (как прежде).
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]!;
  const size = src.thumbnail.getSize();
  if (!size.width || !size.height) throw new Error("пустой кадр захвата экрана");
  return { img: src.thumbnail, w: size.width, h: size.height, sx: size.width / b.width, sy: size.height / b.height, display };
}

/** DIP-регион → прямоугольник натива (целые px, клампнут в картинку). Регион мимо монитора → null. */
export function nativeRect(shot: NativeShot, dip: Rect): Rect | null {
  const b = shot.display.bounds;
  const x0 = Math.max(0, Math.floor((dip.x - b.x) * shot.sx));
  const y0 = Math.max(0, Math.floor((dip.y - b.y) * shot.sy));
  const x1 = Math.min(shot.w, Math.ceil((dip.x + dip.w - b.x) * shot.sx));
  const y1 = Math.min(shot.h, Math.ceil((dip.y + dip.h - b.y) * shot.sy));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Размер копии: желаемый множитель к нативу `factor`, урезанный капом (длинная сторона, площадь). Округление вниз —
 * копия НИКОГДА не превышает кап (иначе API молча пережмёт её, и координаты модели разойдутся с кадром).
 */
export function fitSize(w: number, h: number, factor: number, cap: VisionCapLike = {}): { width: number; height: number } {
  let f = factor > 0 ? factor : 1;
  if (cap.maxEdge && cap.maxEdge > 0) f = Math.min(f, cap.maxEdge / Math.max(w, h));
  if (cap.maxPixels && cap.maxPixels > 0) f = Math.min(f, Math.sqrt(cap.maxPixels / (w * h)));
  return { width: Math.max(1, Math.floor(w * f + 1e-6)), height: Math.max(1, Math.floor(h * f + 1e-6)) };
}

/** Кроп натива + ресайз под размер; возвращает картинку и её РЕАЛЬНЫЙ размер. */
export function cropResize(shot: NativeShot, r: Rect | null, size: { width: number; height: number }): { img: NativeImage; w: number; h: number } {
  let img = r && (r.x !== 0 || r.y !== 0 || r.w !== shot.w || r.h !== shot.h) ? shot.img.crop({ x: r.x, y: r.y, width: r.w, height: r.h }) : shot.img;
  const cur = img.getSize();
  if (cur.width !== size.width || cur.height !== size.height) img = img.resize({ width: size.width, height: size.height, quality: "best" });
  const out = img.getSize();
  return { img, w: out.width, h: out.height };
}
