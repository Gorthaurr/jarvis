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
import { NotImplementedError } from "./input.js";
import { sidecar } from "./sidecar-client.js";

const log = createLogger("actuator:windows");

export interface WindowInfo {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  foreground: boolean;
  minimized: boolean;
}

export interface WindowFocusResult {
  focused: boolean;
  hwnd: number;
  title: string;
}

function ensure(): void {
  if (!sidecar().ready) throw new NotImplementedError("сайдкар окон не запущен");
}

/** Перечислить видимые титулованные окна верхнего уровня. */
export async function listWindows(): Promise<WindowInfo[]> {
  ensure();
  const data = (await sidecar().request("window.list", {}, 8_000)) as { windows?: WindowInfo[] };
  return Array.isArray(data?.windows) ? data.windows : [];
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
  const data = (await sidecar().request("window.focus", { hwnd: opts.hwnd, query: opts.query }, 8_000)) as WindowFocusResult;
  return { focused: Boolean(data?.focused), hwnd: Number(data?.hwnd ?? 0), title: String(data?.title ?? "") };
}
