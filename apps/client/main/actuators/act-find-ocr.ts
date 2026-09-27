/**
 * W2 П5 (G-12): OCR-ступень поиска цели act — В ОКНЕ, а не по всему экрану.
 *
 * Раньше act читал OCR всего монитора: «Отправить» из соседнего окна (или из чата самого Джарвиса, где модель только
 * что это слово написала) становилось целью клика. Теперь: регион OCR = rect окна `app` (hwnd, который сфокусировал
 * act) или переднего окна; строка засчитывается, только если в её центре ВЕРХНЕЕ по z-order окно — искомое (не
 * перекрыто чужим), и никогда — если там окно самого Джарвиса. Центр строки — в экранных DIP (mapping OCR).
 */
import { type Point, type Rect, physicalRectToDip } from "./coords.js";
import { screenOcr } from "./sensors-cheap.js";
import { type WindowInfo, listWindows } from "./windows.js";

export interface OcrHit {
  text: string;
  /** Центр строки, экранные DIP. */
  point: Point;
}

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ");
const contains = (r: Rect, p: Point): boolean => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

interface Placed {
  win: WindowInfo;
  dip: Rect;
}

/** Окна в z-порядке (сверху вниз) с DIP-прямоугольниками; свёрнутые и без размера — не участвуют. */
async function placedWindows(): Promise<Placed[]> {
  try {
    const wins = await listWindows();
    return wins.filter((w) => !w.minimized && w.rect && w.rect.w > 0 && w.rect.h > 0).map((w) => ({ win: w, dip: physicalRectToDip(w.rect) }));
  } catch {
    return []; // окна неизвестны — OCR монитора, фильтр по окнам невозможен (честная деградация)
  }
}

/**
 * Строки OCR с текстом `text` в окне поиска. Точные совпадения главнее подстрок. `scope` — где искали (для ошибок).
 */
export async function findOcrLines(text: string, hwnd?: number): Promise<{ matches: OcrHit[]; scope: string; mapped: boolean }> {
  const placed = await placedWindows();
  const target = placed.find((p) => (hwnd !== undefined ? p.win.hwnd === hwnd : p.win.foreground && p.win.pid !== process.pid));
  const rect = target ? { ...target.dip, space: "screen" as const } : undefined;
  const ocr = await screenOcr(undefined, rect);
  const m = ocr.mapping as { boundsX: number; boundsY: number; scale: number } | undefined;
  if (!m) return { matches: [], scope: "экран", mapped: false };
  const topAt = (p: Point): WindowInfo | undefined => placed.find((w) => contains(w.dip, p))?.win;
  const t = norm(text);
  const hits = ocr.lines
    .filter((l) => norm(l.text).includes(t))
    .map((l) => ({ text: l.text, point: { x: m.boundsX + (l.x + l.w / 2) / m.scale, y: m.boundsY + (l.y + l.h / 2) / m.scale } }))
    .filter((h) => {
      const top = topAt(h.point);
      if (top?.pid === process.pid) return false; // своё окно (чат Джарвиса поверх) — не цель
      return !target || !top || top.hwnd === target.win.hwnd; // перекрыто чужим окном — не в окне поиска
    });
  const exact = hits.filter((h) => norm(h.text) === t);
  return { matches: exact.length ? exact : hits, scope: target ? `окне «${target.win.title.slice(0, 40)}»` : "экране", mapped: true };
}
