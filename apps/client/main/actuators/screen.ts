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
}

/** Маппинг последнего захвата: image-координаты → логические (DIP) virtual-desktop координаты для клика. */
export interface CaptureMapping {
  /** Смещение монитора в логических (DIP) координатах виртуального десктопа. */
  boundsX: number;
  boundsY: number;
  /** thumbnail_px / monitor_dip (image-координату делим на scale → DIP внутри монитора). */
  scale: number;
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

export async function captureScreen(which?: string | number): Promise<ScreenShot> {
  const display = pickDisplay(which);
  const { width, height } = display.size;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const thumbnailSize = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };

  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  if (sources.length === 0) throw new Error("нет источников экрана для захвата");
  // Сопоставляем источник выбранному монитору по display_id; иначе — первый доступный.
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]!;
  const png = src.thumbnail.toPNG();
  if (png.length === 0) throw new Error("пустой кадр захвата экрана");
  // Запоминаем маппинг для клика по vision-координатам (image → логические virtual-desktop).
  lastMapping = { boundsX: display.bounds.x, boundsY: display.bounds.y, scale };
  log.info("screen.capture", {
    display: display.id,
    which: which ?? "active",
    w: thumbnailSize.width,
    h: thumbnailSize.height,
    bytes: png.length,
  });
  return { image: png.toString("base64"), mediaType: "image/png", width: thumbnailSize.width, height: thumbnailSize.height };
}
