/**
 * Сенсоры контекста клиента (§9) — вход salience-движка сервера.
 *
 * Собирает ClientContext (§5): активное приложение, fullscreen, занятость микрофона
 * communications-приложением (Zoom/Discord/телефония), залочен ли экран. Сервер использует
 * это, чтобы решать, уместно ли проактивно вмешиваться (§9): не дёргать во время звонка/игры.
 *
 * На Windows реальный сбор — через UIA/Win32 (foreground window, fullscreen-флаг) и аудио-сессии
 * (occupied mic). Часть — через сайдкар apps/sidecar-win.
 *
 * // TODO(M3): реализовать реальный сбор; на M0 возвращаем безопасные дефолты.
 */
import { EventEmitter } from "node:events";
import type { ClientContext } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";

const log = createLogger("sensors");

export interface SensorsEvents {
  /** Периодический/событийный снимок контекста -> отправляется как client.context. */
  context: [ClientContext];
}

export class Sensors extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs = 5000): void {
    log.info("(stub) sensors запущены (M3) — безопасные дефолты контекста");
    this.timer = setInterval(() => this.emit("context", this.snapshot()), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Текущий снимок. На M0 — консервативные дефолты (не мешать = не блокировать). */
  snapshot(): ClientContext {
    return {
      activeApp: "unknown",
      fullscreen: false,
      micBusyByOtherApp: false,
      locked: false,
    };
  }
}
