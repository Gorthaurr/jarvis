/**
 * Голосовой слой (§10) — заметка-скелет и стабильный контракт.
 *
 * АРХИТЕКТУРНОЕ РЕШЕНИЕ: voice/ — это ОТДЕЛЬНЫЙ процесс, а не часть gateway.
 * Внутрь идёт аудио (WebRTC через LiveKit), наружу — события (транскрипт,
 * VAD, barge-in) и команда «произнести». Контракт между процессами стабилен,
 * поэтому смену рантайма (LiveKit ↔ Pipecat) можно сделать заменой процесса
 * без правок brain/gateway.
 *
 * Здесь — только типы контракта и стаб-фасад. Реальный процесс — TODO(M1).
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("voice");

/** События из голосового процесса в brain (наружу). */
export type VoiceOutEvent =
  | { kind: "transcript"; text: string; final: boolean }
  | { kind: "vad"; state: "speech_start" | "speech_end" | "barge_in" }
  | { kind: "audio_started" } // первый звук пошёл (метрика TARGET_FIRST_AUDIO_MS)
  | { kind: "audio_done" }; // конец произнесения → окно follow-up (§10)

/** Команды в голосовой процесс из brain (внутрь). */
export type VoiceInCommand =
  | { kind: "speak"; text: string } // синтезировать и проиграть
  | { kind: "stop" } // прервать речь (barge-in handling)
  | { kind: "set_followup"; ms: number };

/**
 * Контракт голосового процесса. Реализация (LiveKit/Pipecat) — за интерфейсом,
 * запускается как отдельный процесс и общается по IPC/WS (§10).
 */
export interface IVoiceProcess {
  /** Отправить команду в голосовой процесс. */
  send(cmd: VoiceInCommand): void;
  /** Подписаться на события из голосового процесса. */
  onEvent(cb: (e: VoiceOutEvent) => void): void;
  /** Жив ли процесс. */
  readonly running: boolean;
}

/** Стаб-фасад: ничего не воспроизводит, только логирует (до M1). */
export class StubVoiceProcess implements IVoiceProcess {
  readonly running = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  send(_cmd: VoiceInCommand): void {
    // TODO(M1): проксировать в реальный голосовой процесс (LiveKit/Pipecat).
    log.debug("voice стаб: команда проигнорирована (M1)");
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onEvent(_cb: (e: VoiceOutEvent) => void): void {
    // TODO(M1): подписка на события реального процесса.
  }
}
