/**
 * W2 П5: снять монитор или регион → картинка + её геометрия в DIP. Кадр НЕ регистрирует — это делает потребитель,
 * которому модель будет отвечать координатами (screen.ts: f/z/s; screen-ocr.ts: o). Датчики (проба, отпечаток
 * выделения, OCR ожидания/наблюдения/act) снимают этим же путём, не засоряя реестр кадров и не сдвигая ничьих координат.
 *
 * Регион: в кадре `frame` → монитор ЭТОГО кадра (не передний и не под курсором: кадр мог быть снят с другого);
 * `space:"screen"` → монитор, содержащий регион; ни того ни другого → NoFrameError (догадок нет).
 */
import type { Display, NativeImage } from "electron";
import { type FrameMeta, type Point, type Rect, UnknownFrameError, frameRectToDip, getFrame } from "./frames.js";
import { rectToDip } from "./coords.js";
import { displayById, displayForDipRect, pickDisplay } from "./screen-display.js";
import { type VisionCapLike, cropResize, fitSize, grabNative, nativeRect } from "./screen-native.js";

/** Регион (§Волна2 2.3): в кадре frame или абсолютные DIP (space:"screen", SDK/§8). */
export interface CaptureRect extends Rect {
  space?: "screen";
  frame?: string;
}

export interface Grab {
  img: NativeImage;
  w: number;
  h: number;
  display: Display;
  /** DIP-точка (0,0) картинки и пикселей картинки на DIP. */
  origin: Point;
  sx: number;
  sy: number;
  /** Пикселей НАТИВА на DIP (для OCR: сколько деталей реально есть). */
  nativeSx: number;
  /** Кадр, в системе которого задан регион (зум из него). */
  from?: FrameMeta;
}

export interface GrabOpts {
  /** Множитель к нативу (кламп 0.25..2). Не задан → 1; у зума из кадра — ×2, если кадр не был ужат (натив мельче капа). */
  scale?: number;
  zoom?: boolean;
  cap?: VisionCapLike;
}

async function resolveRegion(which: string | number | undefined, rect: CaptureRect): Promise<{ display: Display; dip: Rect; from?: FrameMeta }> {
  if (rect.space !== "screen" && rect.frame) {
    const from = getFrame(rect.frame);
    const display = displayById(from.displayId);
    if (!display) throw new UnknownFrameError(from.id, "снят с монитора, которого сейчас нет");
    return { display, dip: frameRectToDip(from, rect), from };
  }
  const dip = rectToDip(rect); // space:"screen" → как есть; без кадра — NoFrameError
  return { display: await displayForDipRect(dip, which), dip };
}

/** Снять монитор (rect нет) или регион натива → картинка под множитель и кап. */
export async function grabImage(which: string | number | undefined, rect: CaptureRect | undefined, o: GrabOpts = {}): Promise<Grab> {
  const region = rect ? await resolveRegion(which, rect) : null;
  const display = region ? region.display : await pickDisplay(which);
  const shot = await grabNative(display);
  const nr = region ? nativeRect(shot, region.dip) : { x: 0, y: 0, w: shot.w, h: shot.h };
  if (!nr) throw new Error("регион вне монитора — снимать нечего; проверь координаты и кадр");
  const from = region?.from;
  // Зум из кадра: кадр не ужимали (натив не крупнее копии) → натив деталей не прибавит, увеличиваем ×2.
  const zoomDefault = o.zoom && from && from.sx >= shot.sx * 0.99 ? 2 : 1;
  const factor = o.scale !== undefined ? Math.max(0.25, Math.min(2, o.scale)) : zoomDefault;
  const out = cropResize(shot, nr, fitSize(nr.w, nr.h, factor, o.cap));
  const b = display.bounds;
  const dipW = nr.w / shot.sx;
  const dipH = nr.h / shot.sy;
  return {
    img: out.img,
    w: out.w,
    h: out.h,
    display,
    origin: { x: b.x + nr.x / shot.sx, y: b.y + nr.y / shot.sy },
    sx: out.w / dipW,
    sy: out.h / dipH,
    nativeSx: shot.sx,
    ...(from ? { from } : {}),
  };
}
