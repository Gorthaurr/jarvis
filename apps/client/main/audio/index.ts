/**
 * Аудио-координация в main-процессе (§3, §10, §0.6).
 *
 * ВАЖНО (§3): захват И воспроизведение аудио ЖИВУТ В RENDERER (getUserMedia +
 * WebRTC AEC). main НЕ трогает аудиоустройства — он принимает PCM-кадры из renderer
 * (IPC), прогоняет wake word + VAD и ГЕЙТИТ стрим:
 *   - до wake word / push-to-talk аудио на сервер НЕ уходит (§0.6 privacy-инвариант);
 *   - после активации шлёт audio.frame + audio.vad;
 *   - barge-in (речь во время TTS) → сигнал renderer заглушить плеер (§10);
 *   - закрытие гейта при возврате сервера в idle (после follow-up окна §10).
 *
 * Сам PCM в проде идёт по WebRTC (LiveKit); audio.frame по WS — dev-заглушка (§5).
 */
import type { ClientState, VadEvent } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { type IWakeWord, MockWakeWord } from "../wakeword/index.js";
import { EnergyVad, type IVad } from "../vad/index.js";

export interface AudioCoordinatorDeps {
  wakeword?: IWakeWord;
  vad?: IVad;
  /** Отправить кадр PCM на сервер (audio.frame, dev §5). */
  sendFrame: (pcm: Int16Array) => void;
  /** Отправить VAD-событие на сервер (audio.vad). */
  sendVad: (state: VadEvent["state"]) => void;
  /** Сообщить renderer состояние микрофона (горячий/закрыт) — индикация орба. */
  onMicState?: (open: boolean) => void;
  /** Сигнал renderer мгновенно заглушить плеер TTS (barge-in §10). */
  onBargeIn?: () => void;
  log?: Logger;
}

export class AudioCoordinator {
  private readonly wakeword: IWakeWord;
  private readonly vad: IVad;
  private readonly log: Logger;
  private gateOpen = false;
  private serverSpeaking = false;

  constructor(private readonly deps: AudioCoordinatorDeps) {
    this.wakeword = deps.wakeword ?? new MockWakeWord();
    this.vad = deps.vad ?? new EnergyVad();
    this.log = deps.log ?? createLogger("audio");
  }

  get streaming(): boolean {
    return this.gateOpen;
  }

  /** Push-to-talk / явная активация (когда реальный wake word недоступен, §18). */
  activate(): void {
    if (!this.gateOpen) this.openGate("manual");
  }

  /** Принять кадр PCM16 из renderer. */
  ingest(pcm: Int16Array): void {
    if (!this.gateOpen) {
      // Гейт закрыт: аудио на сервер НЕ уходит (§0.6). Только wake word локально.
      if (this.wakeword.ready && this.wakeword.process(pcm)) {
        this.openGate("wakeword");
        this.streamFrame(pcm);
      }
      return;
    }
    this.streamFrame(pcm);
  }

  /** Сервер сообщил своё состояние (client.state): отслеживаем speaking и idle. */
  setServerState(state: ClientState): void {
    this.serverSpeaking = state === "speaking";
    // Возврат в idle (после follow-up окна на сервере) → закрываем гейт.
    if (state === "idle") this.closeGate();
  }

  /** Принудительно закрыть микрофон (честный mute, §0.6). */
  mute(): void {
    this.closeGate();
  }

  // ── внутреннее ─────────────────────────────────────────────

  private streamFrame(pcm: Int16Array): void {
    const sig = this.vad.process(pcm);
    if (sig === "speech_start") {
      if (this.serverSpeaking) {
        // Речь поверх TTS — barge-in (§10): рубим воспроизведение и сигналим серверу.
        this.deps.onBargeIn?.();
        this.deps.sendVad("barge_in");
      } else {
        this.deps.sendVad("speech_start");
      }
    } else if (sig === "speech_end") {
      this.deps.sendVad("speech_end");
    }
    this.deps.sendFrame(pcm);
  }

  private openGate(reason: string): void {
    this.gateOpen = true;
    this.log.debug("гейт микрофона ОТКРЫТ", { reason });
    this.deps.onMicState?.(true);
  }

  private closeGate(): void {
    if (!this.gateOpen) return;
    this.gateOpen = false;
    this.log.debug("гейт микрофона ЗАКРЫТ");
    this.deps.onMicState?.(false);
  }
}
