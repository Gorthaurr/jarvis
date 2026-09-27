/**
 * W2 П5 «Кадры» (решение №6): координаты модели ВСЕГДА относятся к кадру, который она видела, — не к «последнему
 * снимку» процесса (lastMapping сдвигали сенсорные захваты, зум и чужая задача; клик уходил мимо с ok).
 *
 * Реестр — LRU ~64 записей, ТОЛЬКО метаданные: картинки не храним (натив 4K BGRA ≈ 33 МБ). Кадр описывает, куда
 * ложится его картинка в DIP virtual-desktop: `origin` (DIP точки (0,0) картинки) и пикселей картинки на DIP по осям
 * (`sx`, `sy` — по РЕАЛЬНОМУ размеру картинки: desktopCapturer отдаёт 2559×1439 вместо запрошенных 2560×1440).
 *
 * id = `<bootTag><f|z|o|s><n>`: метка загрузки клиента (3 знака), вид — f полный кадр, z зум, o OCR, s выделение.
 * Вытесненный кадр или кадр прошлой загрузки клиента → «кадр устарел, пересними» (UnknownFrameError), точка вне
 * картинки кадра → OutOfFrameError: координаты не из этого кадра (натив вместо кадра, кадр другого монитора) — это
 * ошибка, а не клик мимо.
 */

export type FrameKind = "f" | "z" | "o" | "s";

export interface FrameMeta {
  id: string;
  kind: FrameKind;
  displayId: number;
  /** Границы дисплея (DIP) на момент съёмки. */
  boundsDIP: { x: number; y: number; width: number; height: number };
  /** DIP-точка, в которую ложится (0,0) картинки кадра. */
  origin: { x: number; y: number };
  /** Пикселей картинки кадра на один DIP (по осям). */
  sx: number;
  sy: number;
  /** Размер картинки кадра (px). */
  w: number;
  h: number;
  t: number;
  /** z/s: полный кадр задачи, из которого взят регион (если известен). */
  zoomOf?: string;
}

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const FRAME_LRU_MAX = 64;
/** Допуск на границе картинки (px кадра): модель целится в край кнопки у кромки экрана. */
const EDGE_TOLERANCE = 1;

const newTag = (): string => {
  const a = "abcdeghijklmnpqrtuvwxy"; // без f/z/o/s — метка не путается с видом кадра при чтении глазами
  const d = "0123456789";
  const pick = (s: string): string => s[Math.floor(Math.random() * s.length)]!;
  return pick(a) + pick(d) + pick(a);
};

let tag = newTag();
let seq = 0;
const lru = new Map<string, FrameMeta>();

/** Кадр неизвестен: вытеснен из LRU или снят до перезапуска клиента. Ничего не нажато. */
export class UnknownFrameError extends Error {
  readonly actionCode = "not_found" as const;
  constructor(frame: string, why = "неизвестен или устарел") {
    super(`кадр «${String(frame).slice(0, 40)}» ${why} — кадр устарел, пересними screen_capture и возьми координаты с него; ничего не нажато`);
    this.name = "UnknownFrameError";
  }
}

/** Координаты без кадра и без space:"screen": не к чему их привязать. */
export class NoFrameError extends Error {
  readonly actionCode = "not_found" as const;
  constructor() {
    super("координаты без кадра: сначала screen_capture (или look{text}) и бери координаты с него; ничего не нажато");
    this.name = "NoFrameError";
  }
}

/** Точка/регион вне картинки кадра — координаты из другой системы (натив, чужой монитор). */
export class OutOfFrameError extends Error {
  readonly actionCode = "not_found" as const;
  constructor(f: FrameMeta, what: string) {
    super(`${what} вне кадра ${f.id} (${f.w}×${f.h}) — координаты не из этого кадра; пересними и возьми их с картинки; ничего не нажато`);
    this.name = "OutOfFrameError";
  }
}

export const bootTag = (): string => tag;

/** Зарегистрировать кадр: выдаёт id, вытесняет самый давний сверх FRAME_LRU_MAX. */
export function registerFrame(m: Omit<FrameMeta, "id" | "t">): FrameMeta {
  seq += 1;
  const f: FrameMeta = { ...m, id: `${tag}${m.kind}${seq}`, t: Date.now() };
  lru.set(f.id, f);
  while (lru.size > FRAME_LRU_MAX) lru.delete(lru.keys().next().value as string);
  return f;
}

/** Метаданные кадра (освежает его в LRU). Чужой/вытесненный → UnknownFrameError. */
export function getFrame(id: string): FrameMeta {
  const f = lru.get(id);
  if (!f) throw new UnknownFrameError(id, id.startsWith(tag) ? "вытеснен более новыми кадрами" : "снят до перезапуска клиента");
  lru.delete(id);
  lru.set(id, f);
  return f;
}

/** Мягкий поиск (без ошибки) — для систем вывода датчиков: нет кадра → свой кадр датчика. */
export const findFrame = (id: string | undefined): FrameMeta | undefined => (id ? lru.get(id) : undefined);

const inside = (f: FrameMeta, x: number, y: number): boolean =>
  x >= -EDGE_TOLERANCE && y >= -EDGE_TOLERANCE && x <= f.w + EDGE_TOLERANCE && y <= f.h + EDGE_TOLERANCE;

/** Точка картинки кадра → DIP. Вне картинки → OutOfFrameError (никогда не клик мимо). */
export function frameToDip(f: FrameMeta, x: number, y: number): Point {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !inside(f, x, y)) throw new OutOfFrameError(f, `точка ${x},${y}`);
  return { x: f.origin.x + x / f.sx, y: f.origin.y + y / f.sy };
}

/** Регион картинки кадра → DIP. Регион, не задевающий картинку, → OutOfFrameError. */
export function frameRectToDip(f: FrameMeta, r: Rect): Rect {
  const ok = [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0 && r.x < f.w && r.y < f.h && r.x + r.w > 0 && r.y + r.h > 0;
  if (!ok) throw new OutOfFrameError(f, `регион ${r.x},${r.y} ${r.w}×${r.h}`);
  return { x: f.origin.x + r.x / f.sx, y: f.origin.y + r.y / f.sy, w: r.w / f.sx, h: r.h / f.sy };
}

/** DIP → точка картинки кадра (обратное frameToDip, без проверки границ). */
export const dipToFrame = (f: FrameMeta, p: Point): Point => ({ x: (p.x - f.origin.x) * f.sx, y: (p.y - f.origin.y) * f.sy });

/** DIP-регион → регион картинки кадра. */
export function dipRectToFrame(f: FrameMeta, r: Rect): Rect {
  const a = dipToFrame(f, r);
  return { x: a.x, y: a.y, w: r.w * f.sx, h: r.h * f.sy };
}

/** Центр региона кадра лежит на его картинке (bbox look/OCR вне кадра модели не отдаём). */
export const rectCenterInFrame = (f: FrameMeta, r: Rect): boolean => inside(f, r.x + r.w / 2, r.y + r.h / 2);

/** Маппинг для SDK (протокол OcrData.mapping): DIP = boundsX + x / scale. */
export const mappingOf = (f: Pick<FrameMeta, "origin" | "sx">): { boundsX: number; boundsY: number; scale: number } => ({
  boundsX: f.origin.x,
  boundsY: f.origin.y,
  scale: f.sx,
});

/** Тесты: чистый реестр; tag — смоделировать перезапуск клиента (другая метка загрузки). */
export function _resetFramesForTest(newBootTag?: string): void {
  lru.clear();
  seq = 0;
  tag = newBootTag ?? newTag();
}
