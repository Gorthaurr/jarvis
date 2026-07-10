/**
 * Сенсоры контекста клиента (§9) — вход «уважительной проактивности» сервера.
 *
 * Собирает ClientContext (§5): активное приложение, fullscreen, занятость микрофона
 * communications-приложением (Zoom/Discord/телефония), залочен ли экран. Сервер использует
 * это, чтобы НЕ дёргать пользователя проактивной речью во время звонка/игры/блокировки
 * (см. pipeline.isUserBusy / speakQueued).
 *
 * Сама Sensors — БЕЗ зависимости от Electron (тестируема): реальные сигналы инжектит main через
 * setLocked/setFullscreen/setActiveApp (powerMonitor lock-события и т.п.). Снимок шлётся как
 * client.context периодически И сразу при изменении (emit on change → проактивность отдаётся быстро).
 *
 * Реализовано: `locked` (powerMonitor lock/unlock в main — надёжно). TODO: реальные fullscreen
 * (Win32 foreground-rect) и micBusyByOtherApp (аудио-сессии) — пока дефолт false, гейт их учтёт сам.
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
  private locked = false;
  private fullscreen = false;
  private micBusyByOtherApp = false;
  private activeApp = "unknown";

  start(intervalMs = 5000): void {
    log.info("sensors запущены (§9 не мешать) — locked через powerMonitor, остальное дефолт");
    this.emit("context", this.snapshot()); // сразу отдать стартовый контекст
    this.timer = setInterval(() => this.emit("context", this.snapshot()), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** §9: экран заблокирован/разблокирован (powerMonitor 'lock-screen'/'unlock-screen' из main). */
  setLocked(v: boolean): void {
    if (this.locked === v) return;
    this.locked = v;
    this.emit("context", this.snapshot()); // ИЗМЕНЕНИЕ → сразу шлём (сервер отдаст отложенную речь по разблокировке)
  }

  /** §9: активное приложение полноэкранно (игра/видео/презентация) — инжектит main, когда научится. */
  setFullscreen(v: boolean): void {
    if (this.fullscreen === v) return;
    this.fullscreen = v;
    this.emit("context", this.snapshot());
  }

  /** §9: микрофон занят другим приложением (звонок) — инжектит main. */
  setMicBusy(v: boolean): void {
    if (this.micBusyByOtherApp === v) return;
    this.micBusyByOtherApp = v;
    this.emit("context", this.snapshot());
  }

  setActiveApp(name: string): void {
    this.activeApp = name || "unknown";
  }

  /** Текущий снимок контекста. */
  snapshot(): ClientContext {
    return {
      activeApp: this.activeApp,
      fullscreen: this.fullscreen,
      micBusyByOtherApp: this.micBusyByOtherApp,
      locked: this.locked,
    };
  }
}
