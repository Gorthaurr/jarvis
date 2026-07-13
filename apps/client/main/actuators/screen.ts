/**
 * Захват экрана (§ зрение): снять монитор и вернуть base64 PNG для vision-модели.
 * Через Electron desktopCapturer (без нативного кода/сайдкара).
 *
 * §6B/игры: РАНЬШЕ всегда снимал «рабочий монитор Джарвиса» (вторичный) → если игра/нужное окно на
 * ДРУГОМ мониторе (напр. Dota на основном), Джарвис «смотрел не туда» и не видел кнопок. Теперь по
 * умолчанию снимаем АКТИВНЫЙ монитор — под курсором (в игре курсор в игре → её монитор). Можно явно
 * выбрать: "active"|"primary"|"jarvis"|<индекс>.
 *
 * Длинная сторона капится ~1568px (Anthropic всё равно даунскейлит; токены ≈ w*h/750). При захвате
 * ЗАПОМИНАЕМ маппинг (смещение монитора в DIP + scale), чтобы input.click по vision-координатам попадал
 * в реальную точку (image-координаты → логические virtual-desktop). media_type — image/png.
 */
import { type Display, desktopCapturer, screen } from "electron";
import { createLogger } from "@jarvis/shared";
import { monitors } from "../monitors.js";

const log = createLogger("actuator:screen");
const MAX_EDGE = 1568;

export interface ScreenShot {
  image: string; // base64 PNG
  mediaType: "image/png";
  width: number;
  height: number;
  /**
   * Маппинг image→screen-DIP ЭТОГО кадра (полный снимок без rect). Возвращается ВСЕГДА, независимо от
   * updateMapping — чтобы потребитель (напр. OCR в jarvis SDK) мог сам конвертировать image-координаты
   * в АБСОЛЮТНЫЕ экранные DIP (boundsX + x/scale) и кликнуть space:"screen", не завися от lastMapping.
   */
  mapping?: CaptureMapping;
}

/** Маппинг последнего захвата: image-координаты → логические (DIP) virtual-desktop координаты для клика. */
export interface CaptureMapping {
  /** Смещение монитора в логических (DIP) координатах виртуального десктопа. */
  boundsX: number;
  boundsY: number;
  /** thumbnail_px / monitor_dip (image-координату делим на scale → DIP внутри монитора). */
  scale: number;
  /** Дисплей последнего ПОЛНОГО снимка — кроп по image-координатам должен сниматься с НЕГО же
   *  (ревью Волны 2: «active» под курсором мог смениться → кроп молча резал не тот монитор). */
  displayId?: number;
}
let lastMapping: CaptureMapping | null = null;
/** Маппинг последнего screen.capture — input.click по coords переводит vision-координаты в экранные. */
export function getLastCaptureMapping(): CaptureMapping | null {
  return lastMapping;
}

/** Выбрать монитор: индекс | "primary" | "jarvis" | "active"(под курсором, дефолт). */
function pickDisplay(which?: string | number): Display {
  const all = screen.getAllDisplays();
  if (typeof which === "number" && which >= 0 && which < all.length) return all[which]!;
  if (which === "primary") return screen.getPrimaryDisplay();
  if (which === "jarvis") return monitors.jarvisDisplay();
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); // active = под курсором
  } catch {
    return screen.getPrimaryDisplay();
  }
}

/** Регион для кропа (§Волна2 2.3): по умолчанию — координаты ПОСЛЕДНЕГО полного снимка; space="screen" — DIP. */
export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
  space?: "screen";
}

export interface CaptureOpts {
  /** Кроп региона (§Волна2 2.3) — сверка кнопки за ~50-200 токенов вместо полного 2K-кадра. */
  rect?: CaptureRect;
  /** Доп. масштаб кропа (0.25..2; >1 — «лупа» для мелкого текста). */
  scale?: number;
  /**
   * Ревью Волны 2: обновлять ли lastMapping этим захватом. true (деф) — ТОЛЬКО для кадров,
   * которые модель реально ВИДИТ (screen.capture). Внутренние сенсорные захваты (OCR/probe/
   * observe/wait_for) ставят false — иначе они молча сдвигали систему координат кликов модели.
   */
  updateMapping?: boolean;
}

/** rect (image-координаты последнего снимка ИЛИ DIP) → DIP virtual-desktop. */
function rectToDip(rect: CaptureRect): { x: number; y: number; w: number; h: number } {
  if (rect.space === "screen") return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  const m = lastMapping;
  if (!m) return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }; // без прежнего снимка считаем DIP (честная деградация)
  return { x: m.boundsX + rect.x / m.scale, y: m.boundsY + rect.y / m.scale, w: rect.w / m.scale, h: rect.h / m.scale };
}

export async function captureScreen(which?: string | number, opts?: CaptureOpts): Promise<ScreenShot> {
  // Кроп по image-координатам ПРОШЛОГО снимка обязан сниматься с ТОГО ЖЕ дисплея (ревью Волны 2):
  // «active» (под курсором) мог смениться — тогда rect молча резал бы не тот монитор.
  let display = pickDisplay(which);
  if (opts?.rect && opts.rect.space !== "screen" && which === undefined && lastMapping?.displayId !== undefined) {
    const same = screen.getAllDisplays().find((d) => d.id === lastMapping!.displayId);
    if (same) display = same;
  }
  const { width, height } = display.size;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const thumbnailSize = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };

  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  if (sources.length === 0) throw new Error("нет источников экрана для захвата");
  // Сопоставляем источник выбранному монитору по display_id; иначе — первый доступный.
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]!;

  // §Волна2 (2.3): кроп региона. Маппинг НЕ обновляем (клики по vision-координатам продолжают
  // считаться от последнего ПОЛНОГО снимка — кроп не сбивает систему координат модели).
  if (opts?.rect) {
    const dip = rectToDip(opts.rect);
    const ix = Math.round((dip.x - display.bounds.x) * scale);
    const iy = Math.round((dip.y - display.bounds.y) * scale);
    const iw = Math.round(dip.w * scale);
    const ih = Math.round(dip.h * scale);
    const cx = Math.max(0, Math.min(thumbnailSize.width - 1, ix));
    const cy = Math.max(0, Math.min(thumbnailSize.height - 1, iy));
    const cw = Math.max(1, Math.min(thumbnailSize.width - cx, iw));
    const ch = Math.max(1, Math.min(thumbnailSize.height - cy, ih));
    let img = src.thumbnail.crop({ x: cx, y: cy, width: cw, height: ch });
    const extra = opts.scale !== undefined ? Math.max(0.25, Math.min(2, opts.scale)) : 1;
    if (extra !== 1) {
      img = img.resize({ width: Math.max(1, Math.round(cw * extra)), height: Math.max(1, Math.round(ch * extra)) });
    }
    const png = img.toPNG();
    if (png.length === 0) throw new Error("пустой кадр кропа экрана");
    const size = img.getSize();
    log.info("screen.capture (crop)", { display: display.id, w: size.width, h: size.height, bytes: png.length });
    return { image: png.toString("base64"), mediaType: "image/png", width: size.width, height: size.height };
  }

  const png = src.thumbnail.toPNG();
  if (png.length === 0) throw new Error("пустой кадр захвата экрана");
  // Маппинг image→screen-DIP ЭТОГО кадра. Считаем ВСЕГДА и возвращаем (нужен OCR-потребителю для
  // конверсии координат в абсолютные DIP). В lastMapping пишем ТОЛЬКО для кадров, которые видит
  // модель (updateMapping !== false, ревью Волны 2) — сенсорный OCR систему координат кликов не сбивает.
  const mapping: CaptureMapping = { boundsX: display.bounds.x, boundsY: display.bounds.y, scale, displayId: display.id };
  if (opts?.updateMapping !== false) {
    lastMapping = mapping;
  }
  log.info("screen.capture", {
    display: display.id,
    which: which ?? "active",
    w: thumbnailSize.width,
    h: thumbnailSize.height,
    bytes: png.length,
  });
  return { image: png.toString("base64"), mediaType: "image/png", width: thumbnailSize.width, height: thumbnailSize.height, mapping };
}

// ─────────────────────────── §Волна2 (2.3): $0-проба региона ───────────────────────────

export interface ScreenProbe {
  /** 64-битный перцептивный хеш (average-hash 8×8) hex-строкой — сравнивать между вызовами. */
  hash: string;
  /** Средняя яркость региона 0..255 (грубый сигнал «тёмный/светлый»). */
  mean: number;
  width: number;
  height: number;
}

/**
 * Перцептивная проба региона (§Волна2 2.3): «изменилось ли на экране» за $0 — 8×8 average-hash по
 * яркости. НЕ доказательство результата (закон честности: probe ≠ «готово») — только детектор перемен;
 * сверка исхода остаётся за snapshot/OCR/vision.
 */
export async function probeScreen(which?: string | number, rect?: CaptureRect): Promise<ScreenProbe> {
  // updateMapping:false — сенсорный захват не сдвигает систему координат кликов (ревью Волны 2).
  const shot = await captureScreen(which, { rect, updateMapping: false });
  const { nativeImage } = await import("electron");
  const img = nativeImage.createFromBuffer(Buffer.from(shot.image, "base64"));
  const bitmap = img.resize({ width: 8, height: 8 }).toBitmap(); // BGRA 8×8
  const luma: number[] = [];
  for (let i = 0; i + 3 < bitmap.length && luma.length < 64; i += 4) {
    const b = bitmap[i]!;
    const g = bitmap[i + 1]!;
    const r = bitmap[i + 2]!;
    luma.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
  if (luma.length === 0) throw new Error("screen.probe: пустой битмап региона");
  const mean = luma.reduce((a, v) => a + v, 0) / luma.length;
  let hash = 0n;
  for (let i = 0; i < luma.length; i += 1) {
    hash = (hash << 1n) | (luma[i]! >= mean ? 1n : 0n);
  }
  return { hash: hash.toString(16).padStart(16, "0"), mean: Math.round(mean), width: shot.width, height: shot.height };
}
