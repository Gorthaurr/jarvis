/**
 * Подстраховка слова «Джарвис» на стороне VoicePipeline (28.09): оркестрация вокруг судьи WakeRescue. Пайплайн даёт узкий
 * «шов» (seam) — что нужно от его внутренностей; сам конвейер (1800 строк) остаётся тонким.
 *
 * Эпоха сброса: mute / speech_cancel / dispose увеличивают её — фрагмент, который в этот момент разбирается в облаке,
 * устарел и ход не запускает (ревью 28.09, B1/B5). Строгий диктор (JARVIS_SPEAKER_GATE_MODE=strict): у подстраховки нет
 * аудио-отпечатка хода — «чужого» не отличить, не будим.
 */
import { createLogger } from "@jarvis/shared";
import type { ISttProvider } from "../integrations/voice-providers.js";
import { type RescueVerdict, WakeRescue } from "./wake-rescue.js";
import { isBareWake } from "./wake-strict.js";

const log = createLogger("wake-rescue");

export interface RescueSeam {
  stt: () => ISttProvider;
  normalize: (raw: string) => string;
  now: () => number;
  /** Конвейер в покое (idle). */
  idle: () => boolean;
  /** Строгий режим диктора с готовым движком — подстраховка отключена. */
  speakerStrict: () => boolean;
  /** Сбросить флаг «чужой голос» прошлого хода (обычно его сбрасывает ensureStt). */
  clearSpeakerFlag: () => void;
  /** gateWake: команда без обращения ("" — не принята). */
  gate: (text: string) => string;
  /** Только «Джарвис»: окно адресации как после локального wake, ход не запускать. */
  openWindow: () => void;
  /** Запустить ход с командой. */
  startTurn: (cmd: string) => void;
  onVerdict?: (verdict: RescueVerdict, ms: number | undefined) => void;
}

export class PipelineRescue {
  private epoch = 0;
  private dead = false;
  private judge?: WakeRescue;

  constructor(private readonly seam: RescueSeam) {}

  /** mute / speech_cancel: разбираемый сейчас фрагмент устарел. */
  bump(): void {
    this.epoch += 1;
  }

  /** dispose: конвейер мёртв — фрагмент в разборе хода не запустит. */
  kill(): void {
    this.dead = true;
    this.epoch += 1;
  }

  async run(pcm: ArrayBuffer, sampleRate: number, meta: { ms?: number; peak?: number } = {}): Promise<RescueVerdict> {
    const once = this.seam.stt().transcribeOnce?.bind(this.seam.stt());
    if (!once || this.dead || this.seam.speakerStrict()) return "skipped"; // нет разового STT (mock/whisper) / сессия мертва / строгий диктор
    this.judge ??= new WakeRescue({
      transcribe: (b, sr) => once(b, sr),
      normalize: this.seam.normalize,
      isIdle: () => !this.dead && this.seam.idle(),
      epoch: () => this.epoch,
      accept: (text) => this.accept(text),
      now: this.seam.now,
      log,
    });
    const verdict = await this.judge.judge(pcm, sampleRate, meta);
    this.seam.onVerdict?.(verdict, meta.ms);
    return verdict;
  }

  /**
   * С командой — тот же путь, что у «Джарвис» из стрима (gateWake → wake → transcript_final). ТОЛЬКО обращение (владелец
   * договаривает следом) — как локальный wake: окно адресации, ход не запускаем, продолжение придёт потоком (B4).
   */
  private accept(text: string): "turn" | "window" | false {
    if (this.dead || !this.seam.idle()) return false;
    this.seam.clearSpeakerFlag();
    if (isBareWake(text)) {
      this.seam.openWindow();
      return "window";
    }
    const cmd = this.seam.gate(text);
    if (!cmd) return false;
    this.seam.startTurn(cmd);
    return "turn";
  }
}
