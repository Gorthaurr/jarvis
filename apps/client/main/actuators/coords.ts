/**
 * W2: ЕДИНЫЙ перевод координат. Раньше формула «boundsX + x / scale» жила в пяти местах (клик, мышь, act, план точки
 * наблюдения, кроп) и считалась от ГЛОБАЛЬНОГО «последнего снимка» (lastMapping): сенсорный захват, зум или чужая
 * задача молча сдвигали систему координат кликов модели.
 *
 * Системы (П5, решение №6): (а) координаты модели — ВСЕГДА в кадре `frame` (frames.ts: полный кадр задачи, зум, OCR,
 * выделение); без кадра и без `space` — ошибка, а не догадка; (б) `space:"screen"` — абсолютные DIP virtual-desktop
 * (только SDK и реплей-макросы §8; модельный space срезает сервер); (в) ФИЗИЧЕСКИЕ пиксели — rect окна из window.list,
 * bbox снапшота/ground (UIA BoundingRectangle).
 * Электронный `screen` внедряется: на Linux нет `screenToDipRect`/`dipToScreenPoint` (тесты подменяют через setScreenApi).
 */
import * as electron from "electron";
import { NoFrameError, type Point, type Rect, frameRectToDip, frameToDip, getFrame } from "./frames.js";

export { NoFrameError, OutOfFrameError, UnknownFrameError, type Point, type Rect } from "./frames.js";

/** Уточнение системы координат (как в Target/ScreenRect протокола). */
export interface CoordSpace {
  space?: "screen";
  frame?: string;
}

/** Часть Electron `screen`, нужная переводу физика ↔ DIP (Windows). */
export interface ScreenApi {
  screenToDipRect?(win: null, rect: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number };
  dipToScreenPoint?(p: Point): Point;
}

let injected: ScreenApi | null = null;
/** Подменить Electron `screen` (тесты; null — вернуть настоящий). */
export function setScreenApi(api: ScreenApi | null): void {
  injected = api;
}
const screenApi = (): ScreenApi | undefined => injected ?? ((electron as { screen?: ScreenApi }).screen || undefined);

/** Точка модели → DIP virtual-desktop. space:"screen" главнее кадра (SDK/§8); без обоих — NoFrameError. */
export function toDipPoint(x: number, y: number, o: CoordSpace = {}): Point {
  if (o.space === "screen") return { x, y };
  if (o.frame === undefined || o.frame === "") throw new NoFrameError();
  return frameToDip(getFrame(o.frame), x, y);
}

/** Регион модели → DIP (та же логика, что у точки). */
export function rectToDip(r: Rect & CoordSpace): Rect {
  if (r.space === "screen") return { x: r.x, y: r.y, w: r.w, h: r.h };
  if (r.frame === undefined || r.frame === "") throw new NoFrameError();
  return frameRectToDip(getFrame(r.frame), r);
}

/** Физический прямоугольник (window.list, bbox UIA) → DIP. Нет Windows-API (Linux/тест без мока) — как есть. */
export function physicalRectToDip(r: Rect): Rect {
  const api = screenApi();
  if (!api?.screenToDipRect) return { ...r };
  const d = api.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: d.x, y: d.y, w: d.width, h: d.height };
}

/** DIP-точка → физические пиксели (клик сайдкара «в физике», G-7). Нет Windows-API — как есть. */
export function dipToPhysicalPoint(p: Point): Point {
  const api = screenApi();
  return api?.dipToScreenPoint ? api.dipToScreenPoint({ x: p.x, y: p.y }) : { x: p.x, y: p.y };
}
