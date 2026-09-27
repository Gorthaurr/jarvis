/**
 * Захват экрана (§ зрение): снять монитор и вернуть base64 PNG для vision-модели — через Electron desktopCapturer.
 *
 * W2 П5 (кадры вместо lastMapping, G-4/G-6):
 *  - захват в НАТИВНОМ разрешении (screen-native.ts), копия для модели — под кап её зрения (`maxEdge`/`maxPixels` из
 *    команды: сервер шлёт кадр 1080p-класса на high-res моделях, решение владельца №2; без капа — стандартное зрение);
 *  - каждый показанный модели снимок — КАДР (frames.ts) с id: полный — f, зум (rect) — z, выделение — s. Координаты
 *    модели относятся к кадру, в котором она их видела; глобального «последнего снимка» больше нет;
 *  - зум — НОВЫЙ захват: кроп натива по rect в системе кадра (не увеличенная миниатюра), z-кадр со своей системой.
 * Выбор монитора — screen-display.ts; регион и геометрия — screen-grab.ts; проба — screen-probe.ts.
 */
import { VISION_CAPS, createLogger } from "@jarvis/shared";
import { registerFrame } from "./frames.js";
import { type CaptureRect, type Grab, grabImage } from "./screen-grab.js";

export { type CaptureRect } from "./screen-grab.js";
export { type ScreenProbe, perceptualHash, probeScreen } from "./screen-probe.js";

const log = createLogger("actuator:screen");

export interface ScreenShot {
  image: string; // base64 PNG
  mediaType: "image/png";
  width: number;
  height: number;
  /** Кадр этой картинки (протокол CaptureData.frameId); нет у датчикового захвата (register:false). */
  frameId?: string;
  /** Зум: кадр, в системе которого задан rect. */
  zoomOf?: string;
}

export interface CaptureOpts {
  /** Кроп региона — зум (новый захват натива), в кадре frame или space:"screen". */
  rect?: CaptureRect;
  /** Множитель к нативу для региона (0.25..2); не задан — ×2 у зума из неужатого кадра, иначе натив. */
  scale?: number;
  /** Кап копии для модели (команда screen.capture). Не задан — стандартное зрение (1568 / 1,15 Мп). */
  maxEdge?: number;
  maxPixels?: number;
  /** Вид кадра региона: z (зум, деф) | s (выделение: без умолчального ×2). */
  kind?: "z" | "s";
  /** false — датчиковый снимок (отпечаток): кадр не регистрируется, координат модели по нему не будет. */
  register?: boolean;
}

/** Зарегистрировать снимок как кадр (f/z/s) и отдать данные протокола. */
function toShot(g: Grab, kind: "f" | "z" | "s", register: boolean): ScreenShot {
  const png = g.img.toPNG();
  if (png.length === 0) throw new Error("пустой кадр захвата экрана");
  const zoomOf = kind !== "f" && g.from ? g.from.id : undefined;
  const f = register
    ? registerFrame({ kind, displayId: g.display.id, boundsDIP: { ...g.display.bounds }, origin: g.origin, sx: g.sx, sy: g.sy, w: g.w, h: g.h, ...(zoomOf ? { zoomOf } : {}) })
    : undefined;
  log.info("screen.capture", { display: g.display.id, kind, frame: f?.id, w: g.w, h: g.h, bytes: png.length });
  return { image: png.toString("base64"), mediaType: "image/png", width: g.w, height: g.h, ...(f ? { frameId: f.id } : {}), ...(zoomOf ? { zoomOf } : {}) };
}

export async function captureScreen(which?: string | number, opts: CaptureOpts = {}): Promise<ScreenShot> {
  const region = opts.rect !== undefined;
  const std = VISION_CAPS.std;
  const cap = { maxEdge: opts.maxEdge ?? (region ? std.maxEdge : std.frameEdge), maxPixels: opts.maxPixels ?? std.maxPixels };
  const kind = region ? (opts.kind ?? "z") : "f";
  const g = await grabImage(which, opts.rect, { ...(region && opts.scale !== undefined ? { scale: opts.scale } : {}), zoom: kind === "z", cap });
  return toShot(g, kind, opts.register !== false);
}
