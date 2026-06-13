/**
 * Аудио-координация в main-процессе (§3, §5).
 *
 * ВАЖНО (§3): захват И воспроизведение аудио ЖИВУТ В RENDERER (WebRTC, getUserMedia с
 * echoCancellation/AEC). main-процесс НЕ трогает аудиоустройства напрямую — он лишь
 * ГЕЙТИТ стрим: решает, когда микрофон «горячий» (после wake word / в follow-up окне §10),
 * и координирует barge-in (прервать TTS при speech_start). Сам PCM в проде идёт по WebRTC
 * (LiveKit), а НЕ через WS audio.frame (тот — только dev-заглушка, §5).
 *
 * Здесь — интерфейс координатора и стаб-реализация.
 * // TODO(M1): связать с renderer (IPC), LiveKit-сессией и wake/vad-гейтами.
 */
import { EventEmitter } from "node:events";
import { createLogger } from "@jarvis/shared";

const log = createLogger("audio");

/** Команды гейта стрима, которые main отправляет в renderer (через preload IPC). */
export type AudioGate = "open" | "close";

export interface AudioCoordinatorEvents {
  /** main просит renderer открыть/закрыть микрофонный гейт. */
  gate: [AudioGate];
}

/**
 * Координатор аудио. На M0 — пустышка: голос ещё не подключён, вход — текстом (dev.text).
 */
export class AudioCoordinator extends EventEmitter {
  /** Открыть микрофонный гейт (renderer начнёт слать кадры по WebRTC). */
  openMic(): void {
    log.debug("(stub) openMic — гейт микрофона (M1)");
    this.emit("gate", "open");
  }

  /** Закрыть гейт (вне wake/follow-up окна — микрофон не слушает, §10). */
  closeMic(): void {
    log.debug("(stub) closeMic (M1)");
    this.emit("gate", "close");
  }

  /** Barge-in: пользователь заговорил во время TTS -> прервать воспроизведение (§10). */
  onBargeIn(): void {
    log.debug("(stub) bargeIn — прервать TTS (M1)");
    // TODO(M1): сигнал renderer остановить плеер TTS.
  }
}
