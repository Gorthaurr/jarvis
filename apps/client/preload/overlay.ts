/**
 * preload окна-оверлея выделения (§режим выделения, 2026-09-03).
 *
 * Узкий мост: окно умеет ровно две вещи — узнать свой режим (рисуем / показываем рамку) и отдать
 * обведённый прямоугольник. Никакого доступа к остальному API (это окно живёт поверх всего экрана,
 * лишних прав ему давать нельзя).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

export interface OverlayMode {
  mode: "draw" | "frame";
  /** Для "frame" — прямоугольник в координатах ЭТОГО окна (CSS-px = DIP монитора). */
  rect?: { x: number; y: number; w: number; h: number };
  index?: number;
}

contextBridge.exposeInMainWorld("selectionOverlay", {
  onMode: (cb: (m: OverlayMode) => void) => {
    ipcRenderer.on("selection:mode", (_e: IpcRendererEvent, m: OverlayMode) => cb(m));
  },
  /** rect = null — владелец отменил (Esc/правая кнопка/клик без протяжки). */
  submit: (rect: { x: number; y: number; w: number; h: number } | null) => ipcRenderer.send("selection:done", rect),
});
