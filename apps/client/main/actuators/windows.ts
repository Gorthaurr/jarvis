/**
 * §Волна2 (2.4) — Окна верхнего уровня через win-сайдкар: список и фокус.
 *
 * window.list — дешёвый on-demand ответ «появилось ли окно» (hwnd/pid/process/title/
 * foreground/minimized) за миллисекунды, без PowerShell и без 12с-таймера снапшота.
 * window.focus — SetForegroundWindow+AttachThreadInput с ЧЕСТНЫМ readback: focused=false
 * означает «фокус реально не взят» (не ложный успех) — вызывающий откатывается на
 * AppActivate (apps.focusApp) или докладывает провал.
 *
 * Если сайдкар не поднят — NotImplementedError (dispatch → runtime-ошибка).
 */
import { createLogger } from "@jarvis/shared";
import { monitors } from "../monitors.js";
import { NotImplementedError } from "./input.js";
import { sidecar } from "./sidecar-client.js";

const log = createLogger("actuator:windows");

/** Сырое окно от сайдкара: + rect (ФИЗИЧЕСКИЕ пиксели Win32) для привязки к монитору. */
interface RawWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  foreground: boolean;
  minimized: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowInfo {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  foreground: boolean;
  minimized: boolean;
  /** Мультимонитор (2026-07-14): на КАКОМ мониторе окно — индекс СОГЛАСОВАН с screen_capture{monitor}. */
  monitorIndex: number;
  /** Человеко-метка монитора («осн. монитор» / «монитор 2») — для сводки модели. */
  monitor: string;
}

export interface WindowFocusResult {
  focused: boolean;
  hwnd: number;
  title: string;
  /** Монитор сфокусированного окна — чтобы screen_capture{monitor} снял ИМЕННО его (не курсорный). */
  monitorIndex?: number;
  monitor?: string;
}

/** Метка монитора окна по его физическому rect (пустой ИЛИ off-screen rect → без монитора).
 *  Свёрнутое окно у Win32 имеет rect {-32000,-32000,…} (IsIconic) — displayForRect дал бы ЛОЖНЫЙ
 *  «ближайший» монитор (ревью #5); координаты ≤ -30000 = off-screen → монитор неопределён. */
function monitorOf(w: { x: number; y: number; w: number; h: number }): { index: number; label: string } | null {
  if (!w.w || !w.h) return null;
  if (w.x <= -30000 || w.y <= -30000) return null; // свёрнутое/off-screen окно — монитора нет
  try {
    const m = monitors.displayForRect({ x: w.x, y: w.y, width: w.w, height: w.h });
    return { index: m.index, label: m.primary ? "осн. монитор" : `монитор ${m.index + 1}` };
  } catch {
    return null;
  }
}

function ensure(): void {
  if (!sidecar().ready) throw new NotImplementedError("сайдкар окон не запущен");
}

/** Перечислить видимые титулованные окна верхнего уровня — с привязкой окно→монитор (мультимонитор). */
export async function listWindows(): Promise<WindowInfo[]> {
  ensure();
  const data = (await sidecar().request("window.list", {}, 8_000)) as { windows?: RawWindow[] };
  const raw = Array.isArray(data?.windows) ? data.windows : [];
  const multi = monitors.hasMultiple;
  return raw.map((w) => {
    // Свёрнутое окно — монитор неопределён (rect off-screen): честно «свёрнуто», не ложный «монитор N».
    const m = w.minimized ? null : monitorOf(w);
    return {
      hwnd: w.hwnd,
      pid: w.pid,
      process: w.process,
      title: w.title,
      foreground: w.foreground,
      minimized: w.minimized,
      // При одном мониторе индекс всегда 0 — не зашумляем; при нескольких — реальная привязка.
      monitorIndex: m?.index ?? 0,
      monitor: w.minimized ? "свёрнуто" : multi ? (m?.label ?? "монитор ?") : "осн. монитор",
    };
  });
}

/**
 * Сфокусировать окно: hwnd (из window.list, точно) или подстрока заголовка/имени процесса.
 * Возвращает честный readback; focused=false НЕ маскируется под успех.
 */
export async function focusWindow(opts: { hwnd?: number; query?: string }): Promise<WindowFocusResult> {
  ensure();
  if (opts.hwnd === undefined && !opts.query?.trim()) {
    throw new Error("window.focus: нужен hwnd (из window_list) или query (подстрока заголовка/процесса)");
  }
  log.debug("window.focus", opts);
  const data = (await sidecar().request("window.focus", { hwnd: opts.hwnd, query: opts.query }, 8_000)) as WindowFocusResult & {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  };
  const m = monitorOf({ x: data?.x ?? 0, y: data?.y ?? 0, w: data?.w ?? 0, h: data?.h ?? 0 });
  return {
    focused: Boolean(data?.focused),
    hwnd: Number(data?.hwnd ?? 0),
    title: String(data?.title ?? ""),
    monitorIndex: m?.index,
    monitor: monitors.hasMultiple ? m?.label : undefined,
  };
}
