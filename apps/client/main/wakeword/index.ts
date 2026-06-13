/**
 * Wake word — детекция ключевого слова на устройстве (§3, §10).
 *
 * Запускается локально (низкое потребление, без сети), активирует горячий микрофон.
 * Захват аудио — в renderer (§3), сюда приходит уже PCM-поток/фичи для детектора
 * (на проде — нативный детектор, напр. Porcupine, за этим интерфейсом).
 *
 * // TODO(M1): подключить on-device wake word engine + связать с AudioCoordinator (открыть гейт).
 */
import { EventEmitter } from "node:events";
import { createLogger } from "@jarvis/shared";

const log = createLogger("wakeword");

export interface WakeWordEvents {
  /** Сработало ключевое слово -> открыть микрофон, начать слушать (§10). */
  wake: [];
}

export class WakeWord extends EventEmitter {
  private running = false;

  start(): void {
    this.running = true;
    log.info("(stub) wake word detector запущен (M1) — на M0 вход текстом");
  }

  stop(): void {
    this.running = false;
    log.info("(stub) wake word detector остановлен");
  }

  get isRunning(): boolean {
    return this.running;
  }
}
