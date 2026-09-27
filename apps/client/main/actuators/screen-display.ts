/**
 * Какой монитор снимать (вынесено из screen.ts, W2 П5).
 *
 * §6B/игры, мультимонитор-фикс 2026-07-14 (эпизод «вруби демку в дискорде»): по умолчанию (и "active") — монитор
 * ПЕРЕДНЕГО (foreground) окна: то, с чем работают СЕЙЧАС (игра fullscreen-foreground; только что сфокусированное
 * окно). Явно: "cursor" (под курсором) | "primary" | "jarvis" | индекс монитора числом/строкой. Регион в DIP
 * снимается с монитора, СОДЕРЖАЩЕГО его; регион в кадре — с монитора этого кадра (решает screen.ts).
 * Выключатель JARVIS_CAPTURE_FOREGROUND=0 → дефолт = курсор (прежний флаг, не новый).
 */
import { type Display, screen } from "electron";
import { monitors } from "../monitors.js";

/** Монитор под курсором (fallback / явный which="cursor"). */
function cursorDisplay(): Display {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch {
    return screen.getPrimaryDisplay();
  }
}

/** Монитор FOREGROUND-окна; сайдкар недоступен / нет переднего окна → курсор. */
async function foregroundDisplay(): Promise<Display> {
  if (process.env.JARVIS_CAPTURE_FOREGROUND === "0") return cursorDisplay();
  try {
    const { sidecar } = await import("./sidecar-client.js");
    if (!sidecar().ready) return cursorDisplay();
    const { listWindows } = await import("./windows.js");
    const wins = await listWindows();
    const fg = wins.find((w) => w.foreground && !w.minimized);
    const all = screen.getAllDisplays();
    if (fg && fg.monitorIndex >= 0 && fg.monitorIndex < all.length) return all[fg.monitorIndex]!;
  } catch {
    /* сайдкар лёг/таймаут — курсорный фолбэк */
  }
  return cursorDisplay();
}

/** Индекс монитора — number ИЛИ ЧИСЛОВАЯ СТРОКА (схема шлёт monitor строкой, ревью #4/#6). */
const monitorIndex = (which?: string | number): number =>
  typeof which === "number" ? which : typeof which === "string" && /^\d+$/.test(which.trim()) ? Number(which.trim()) : Number.NaN;

/** Выбрать монитор: индекс | "primary" | "jarvis" | "cursor" | "active"/деф (монитор переднего окна). */
export async function pickDisplay(which?: string | number): Promise<Display> {
  const all = screen.getAllDisplays();
  const idx = monitorIndex(which);
  if (Number.isInteger(idx) && idx >= 0 && idx < all.length) return all[idx]!;
  if (which === "primary") return screen.getPrimaryDisplay();
  if (which === "jarvis") return monitors.jarvisDisplay();
  if (which === "cursor") return cursorDisplay();
  return foregroundDisplay();
}

/** Явно ли задан монитор (число/строка-индекс/primary/jarvis/cursor) — тогда DIP-регион его не переопределяет. */
export function isExplicitMonitor(which?: string | number): boolean {
  if (typeof which === "number") return true;
  if (typeof which !== "string") return false;
  return which === "primary" || which === "jarvis" || which === "cursor" || /^\d+$/.test(which.trim());
}

/** Монитор по id кадра (кадр помнит свой дисплей). Монитор отключён → null. */
export const displayById = (id: number): Display | null => screen.getAllDisplays().find((d) => d.id === id) ?? null;

/** Монитор, содержащий центр DIP-региона (ревью #1/#2: клик-точка может быть не на мониторе переднего окна). */
export async function displayForDipRect(r: { x: number; y: number; w: number; h: number }, which?: string | number): Promise<Display> {
  if (isExplicitMonitor(which)) return pickDisplay(which);
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
  } catch {
    return pickDisplay(which);
  }
}
