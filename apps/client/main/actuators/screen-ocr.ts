/**
 * §Волна2 (2.3) / W2 П5: локальный OCR экрана (Windows.Media.Ocr в сайдкаре) — в НАТИВЕ.
 *
 * Раньше OCR читал миниатюру ≤ 1568 px: на 4K мелкий шрифт терялся до распознавания, а строки приходили в системе
 * «последнего снимка», которую сдвигал любой захват. Теперь:
 *  - в сайдкар уходит натив региона; мелкий регион (≤ 1300 px) — ×2 (OCR надёжнее на крупном тексте), кламп 2600;
 *  - натив крупнее 2600 (4K) — полосами с перекрытием (до живой проверки MaxImageDimension, §6 C#: `ocr.limits`);
 *  - строки отдаются в системе переданного кадра задачи (`frame`: система вывода — модель кликает по ним в том же
 *    кадре, что видела), если кадр с того же монитора; иначе — в своём o-кадре (натив региона), и `frame` не ставится;
 *  - `mapping` (DIP = boundsX + x/scale) отдаётся ВСЕГДА, и для rect: SDK пересчитывает строки в экранные DIP.
 * Датчики (ожидание текста, наблюдение, act) зовут без register — o-кадр не регистрируется.
 */
import { createLogger } from "@jarvis/shared";
import { NotImplementedError } from "./sidecar-ready.js";
import { sidecar } from "./sidecar-client.js";
import { type Rect, dipRectToFrame, findFrame, mappingOf, registerFrame } from "./frames.js";
import { type CaptureRect, grabImage } from "./screen-grab.js";
import { ocrTiles, type TileLine } from "./screen-ocr-tiles.js";

const log = createLogger("actuator:ocr");

export type OcrLine = TileLine;

export interface OcrOutcome {
  text: string;
  lines: OcrLine[];
  /** Размер o-кадра (натив региона). */
  width: number;
  height: number;
  /** o-кадр (только при register). */
  frameId?: string;
  /** Кадр задачи, в системе которого отданы строки (нет — строки в o-кадре). */
  frame?: string;
  /** Система строк → экранные DIP: x_dip = boundsX + x / scale. */
  mapping: { boundsX: number; boundsY: number; scale: number };
}

export interface OcrOpts {
  /** Кадр задачи — система вывода строк. */
  frame?: string;
  /** Зарегистрировать o-кадр (ответ модели); датчики — нет. */
  register?: boolean;
}

export async function screenOcr(which?: string | number, rect?: CaptureRect, lang?: string, opts: OcrOpts = {}): Promise<OcrOutcome> {
  if (!sidecar().ready) throw new NotImplementedError("OCR-сайдкар не запущен");
  const g = await grabImage(which, rect); // натив региона, без капа
  const read = await ocrTiles(g.img, g.w, g.h, (imageB64) => sidecar().request("ocr", { imageB64, lang }, 20_000));
  const toDip = (l: OcrLine): Rect => ({ x: g.origin.x + l.x / g.sx, y: g.origin.y + l.y / g.sy, w: l.w / g.sx, h: l.h / g.sy });
  const task = findFrame(opts.frame);
  const inTask = task && task.displayId === g.display.id ? task : undefined;
  // Целые пиксели кадра: точность клика та же, токенов меньше.
  const round = (text: string, r: Rect): OcrLine => ({ text, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
  const lines = read.lines.map((l) => round(l.text, inTask ? dipRectToFrame(inTask, toDip(l)) : l));
  const o = opts.register
    ? registerFrame({ kind: "o", displayId: g.display.id, boundsDIP: { ...g.display.bounds }, origin: g.origin, sx: g.sx, sy: g.sy, w: g.w, h: g.h })
    : undefined;
  log.info("screen.ocr", { display: g.display.id, w: g.w, h: g.h, tiles: read.tiles, factor: read.factor, lines: lines.length, frame: inTask?.id ?? o?.id });
  return {
    text: read.text,
    lines,
    width: g.w,
    height: g.h,
    ...(o ? { frameId: o.id } : {}),
    ...(inTask ? { frame: inTask.id } : {}),
    mapping: mappingOf(inTask ?? g),
  };
}
