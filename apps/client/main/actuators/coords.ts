/**
 * W2 (пакет 0): ЕДИНЫЙ перевод координат. Раньше формула «boundsX + x / scale» жила в пяти местах (клик, мышь, act,
 * план точки наблюдения, кроп) — П5 переводит систему координат модели на кадры, и пять копий разошлись бы.
 *
 * Системы: (а) координаты модели — в кадре `frame` (П5) или, пока кадров нет, последнего полного screen_capture
 * (lastMapping); (б) `space:"screen"` — абсолютные DIP virtual-desktop (SDK, реплей-макросы §8); (в) ФИЗИЧЕСКИЕ
 * пиксели — rect окна из window.list, bbox снапшота/ground (UIA BoundingRectangle).
 * Электронный `screen` внедряется: на Linux нет `screenToDipRect`/`dipToScreenPoint` (тесты подменяют через setScreenApi).
 * Владелец после P0 — П5.
 */
import * as electron from "electron";
import { getLastCaptureMapping } from "./screen.js";

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
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

/** Кадр, которого клиент не знает (П5: вытеснен/чужой bootTag). P0: кадров ещё нет — любой frame неизвестен. */
export class UnknownFrameError extends Error {
  readonly actionCode = "not_found" as const;
  constructor(frame: string) {
    super(`кадр «${String(frame).slice(0, 40)}» неизвестен или устарел — пересними screen_capture и возьми координаты с него; ничего не нажато`);
    this.name = "UnknownFrameError";
  }
}

/** Точка модели → DIP virtual-desktop. */
export function toDipPoint(x: number, y: number, o: CoordSpace = {}): Point {
  if (o.space === "screen") return { x, y };
  if (o.frame !== undefined) throw new UnknownFrameError(o.frame);
  const m = getLastCaptureMapping();
  return m ? { x: m.boundsX + x / m.scale, y: m.boundsY + y / m.scale } : { x, y };
}

/** Регион модели → DIP. Без прежнего снимка — считаем DIP (честная деградация, как прежде у кропа). */
export function rectToDip(r: Rect & CoordSpace): Rect {
  if (r.space === "screen") return { x: r.x, y: r.y, w: r.w, h: r.h };
  if (r.frame !== undefined) throw new UnknownFrameError(r.frame);
  const m = getLastCaptureMapping();
  if (!m) return { x: r.x, y: r.y, w: r.w, h: r.h };
  return { x: m.boundsX + r.x / m.scale, y: m.boundsY + r.y / m.scale, w: r.w / m.scale, h: r.h / m.scale };
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
