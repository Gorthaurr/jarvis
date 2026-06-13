/**
 * VAD — детекция активности речи (§3, §10).
 *
 * Определяет начало/конец речи и barge-in (речь поверх TTS). Фактический анализ —
 * над аудио из renderer (§3, AEC уже применён). Эмитит VadEvent-совместимые состояния,
 * которые main гейтит/прокидывает (audio.vad на сервер при необходимости).
 *
 * // TODO(M1): подключить VAD (напр. Silero/webrtcvad) и связать с AudioCoordinator/barge-in.
 */
import { EventEmitter } from "node:events";
import type { VadEvent } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";

const log = createLogger("vad");

export interface VadEvents {
  vad: [VadEvent];
}

export class Vad extends EventEmitter {
  start(): void {
    log.info("(stub) VAD запущен (M1)");
  }

  stop(): void {
    log.info("(stub) VAD остановлен");
  }

  /** Утилита для будущей эмиссии (типобезопасно сопоставлено с VadEvent.state). */
  protected emitState(state: VadEvent["state"]): void {
    this.emit("vad", { state });
  }
}
