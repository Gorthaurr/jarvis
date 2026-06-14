/**
 * VAD — определение активности речи (§3, §10).
 *
 * Эмитит speech_start/speech_end; barge_in выводится в AudioCoordinator (речь во
 * время воспроизведения TTS). Анализ — над аудио из renderer (§3, AEC уже применён).
 *
 * Штатно — Silero VAD (onnxruntime). Здесь — энергетический VAD (RMS + порог +
 * hangover): работает на чистом PCM без зависимостей, как надёжный fallback и для
 * dev/тестов. onnx подключается опционально (createVad).
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("vad");

/** Сигнал VAD на кадр: смена состояния речи или его отсутствие. */
export type VadSignal = "speech_start" | "speech_end" | null;

export interface IVad {
  /** Прогнать кадр PCM16. Вернуть смену состояния речи (или null). */
  process(pcm: Int16Array): VadSignal;
  /** Идёт ли речь сейчас. */
  readonly speaking: boolean;
}

export interface EnergyVadConfig {
  /** Порог RMS (0..32768) для срабатывания речи. */
  threshold: number;
  /** Сколько подряд «тихих» кадров до speech_end (hangover). */
  hangoverFrames: number;
}

export const DEFAULT_VAD_CONFIG: EnergyVadConfig = {
  threshold: 700,
  hangoverFrames: 12, // ~240 мс при кадрах 20 мс
};

/** RMS-энергия кадра PCM16. */
export function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

/** Энергетический VAD: простой, детерминированный, без зависимостей. */
export class EnergyVad implements IVad {
  private _speaking = false;
  private silence = 0;

  constructor(private readonly config: EnergyVadConfig = DEFAULT_VAD_CONFIG) {}

  get speaking(): boolean {
    return this._speaking;
  }

  process(pcm: Int16Array): VadSignal {
    const energy = rms(pcm);
    if (energy >= this.config.threshold) {
      this.silence = 0;
      if (!this._speaking) {
        this._speaking = true;
        return "speech_start";
      }
      return null;
    }
    // тихий кадр
    if (this._speaking) {
      this.silence += 1;
      if (this.silence >= this.config.hangoverFrames) {
        this._speaking = false;
        this.silence = 0;
        return "speech_end";
      }
    }
    return null;
  }

  reset(): void {
    this._speaking = false;
    this.silence = 0;
  }
}

/**
 * Фабрика VAD: пытается поднять Silero (onnx), иначе энергетический.
 * onnx — опционально (динамический импорт через переменную), чтобы не быть жёсткой
 * зависимостью сборки.
 */
export async function createVad(useSilero = false): Promise<IVad> {
  if (!useSilero) return new EnergyVad();
  try {
    const spec = "onnxruntime-node";
    const ort = (await import(spec).catch(() => null)) as { InferenceSession?: unknown } | null;
    if (!ort?.InferenceSession) {
      log.warn("onnxruntime-node недоступен — энергетический VAD");
      return new EnergyVad();
    }
    // TODO(M1): инференс Silero VAD.
    log.info("onnxruntime доступен; Silero VAD — TODO(M1)");
    return new EnergyVad();
  } catch {
    return new EnergyVad();
  }
}
