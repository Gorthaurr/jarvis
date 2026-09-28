/**
 * Клиентская сторона подстраховки слова «Джарвис» (28.09): отправить серверу фрагмент, на котором локальный детектор
 * промолчал, — и отменить его, если микрофон выключили, пока сервер разбирает. Решение «сейчас покой?» принимает
 * координатор (гейт, mute, состояние сервера, barge) и передаёт флагом; здесь — эхо-хвост и учёт отправленного.
 */
import type { VadEvent } from "@jarvis/protocol";
import type { Logger } from "@jarvis/shared";

/**
 * После конца воспроизведения TTS эхо/хвост ещё может звучать — фрагмент, пойманный сразу за речью Джарвиса, в облако
 * не шлём. Ход владельца после ответа всё равно идёт окном разговора (гейт открыт).
 */
export const RESCUE_ECHO_TAIL_MS = 1_500;
/** Окно, в котором mute отменяет уже отправленный фрагмент (разбор в облаке ≤ ~4 с + запас). */
export const RESCUE_CANCEL_WINDOW_MS = 6_000;

export interface RescueSegment {
  pcm: Int16Array;
  ms: number;
  peak: number;
}

/** Что нужно от координатора аудио (его внутренности остаются его). */
export interface RescuePort {
  /** Покой: гейт закрыт, не mute, слух локальный, сервер idle, Джарвис не говорит. */
  calm: () => boolean;
  /** Гейт можно открыть под продолжение (не mute, ещё закрыт, слух локальный). */
  canOpen: () => boolean;
  open: () => void;
  /** Забрать пре-ролл закрытого гейта (и очистить его). */
  takePreroll: () => Int16Array[];
  stream: (frame: Int16Array) => void;
}

export interface RescueLinkDeps {
  now: () => number;
  log: Logger;
  /** Транспорт: false — сокет закрыт. */
  send: (pcm: Int16Array, meta: { ms: number; peak: number }) => boolean;
  sendVad: (state: VadEvent["state"]) => void;
  port: RescuePort;
}

export class RescueLink {
  private playbackEndedAt = 0;
  private lastSentAt = 0;

  constructor(private readonly d: RescueLinkDeps) {}

  /** Динамик замолчал (был активен → нет). */
  playbackStopped(): void {
    this.playbackEndedAt = this.d.now();
  }

  /** Отрезок-кандидат: уходит серверу, только если координатор подтвердил покой. */
  offer(seg: RescueSegment): void {
    if (!this.d.port.calm()) return;
    if (this.playbackEndedAt > 0 && this.d.now() - this.playbackEndedAt < RESCUE_ECHO_TAIL_MS) return;
    const sent = this.d.send(seg.pcm, { ms: seg.ms, peak: seg.peak });
    if (sent) this.lastSentAt = this.d.now();
    this.d.log.info("wake-rescue: фрагмент отправлен на проверку облачным STT", { ms: seg.ms, peak: seg.peak, sent });
  }

  /**
   * Микрофон выключили. Фрагмент, ушедший недавно, сервер ещё разбирает — speech_cancel: ход по нему не запускать.
   * `speechOpen` — сервер и так узнает об отмене речи отдельным путём.
   */
  onMute(speechOpen: boolean): void {
    if (this.lastSentAt > 0 && this.d.now() - this.lastSentAt < RESCUE_CANCEL_WINDOW_MS && !speechOpen) {
      this.d.sendVad("speech_cancel");
      this.lastSentAt = 0;
    }
  }

  /**
   * Сервер нашёл обращение и принял ход: открываем гейт под продолжение — как после обычного «Джарвис». bare — было ТОЛЬКО
   * «Джарвис» (ход не запущен, у сервера окно адресации): начало команды лежит в пре-ролле — проигрываем его в открывшийся
   * поток. НЕ bare: ход по фрагменту уже идёт — пре-ролл повторять нельзя (дубль команды).
   */
  onRescued(bare: boolean): void {
    const { port } = this.d;
    if (!port.canOpen()) return;
    port.open();
    if (bare) for (const f of port.takePreroll()) port.stream(f);
    this.d.log.info("wake-rescue: обращение спасено облачным STT — гейт открыт под продолжение", { bare });
  }
}
