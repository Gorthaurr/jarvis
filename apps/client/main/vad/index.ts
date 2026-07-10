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
  /**
   * Сколько подряд «громких» кадров нужно ДО speech_start (онсет-дебаунс, §10). Без него
   * энергетический VAD дребезжал на одиночных щелчках/шуме — десятки speech_start/end подряд
   * флудили turn-detector и сбивали окно прослушивания (видно в client.out.log). N кадров
   * устойчивой энергии = реальная речь, не пик. Реплики онсетятся за >60мс, так что не режем.
   */
  onsetFrames: number;
  /**
   * Потолок непрерывной «речи» в кадрах (Б5, форензика 2026-07-10): звук игры из колонок держит
   * RMS выше порога ЧАСАМИ → speech_end не наступал 39 минут, 452 пустых транскрипта, команды
   * внутри такого «хода» не финализировались в принципе. По потолку — форс speech_end +
   * адаптивный подъём порога (перекалибровка под громкий фон). 0 = выкл.
   */
  maxSpeechFrames: number;
}

export const DEFAULT_VAD_CONFIG: EnergyVadConfig = {
  threshold: 700,
  hangoverFrames: 12, // ~240 мс при кадрах 20 мс
  onsetFrames: 3, // ~60 мс устойчивой энергии до speech_start (анти-дребезг)
  maxSpeechFrames: 1000, // ~20 с при кадрах 20 мс — живая команда всегда короче
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
  /** Счётчик подряд «громких» кадров для онсет-дебаунса (см. onsetFrames). */
  private voiced = 0;
  /** Кадры/энергия текущей «речи» (потолок Б5) + адаптивный порог поверх базового. */
  private speechFrames = 0;
  private energyAcc = 0;
  private adaptive = 0; // 0 = работает базовый threshold

  constructor(private readonly config: EnergyVadConfig = DEFAULT_VAD_CONFIG) {}

  get speaking(): boolean {
    return this._speaking;
  }

  /** Действующий порог: базовый либо адаптивно поднятый после «вечной речи» (громкий фон). */
  get effectiveThreshold(): number {
    return Math.max(this.config.threshold, this.adaptive);
  }

  process(pcm: Int16Array): VadSignal {
    const energy = rms(pcm);
    if (energy >= this.effectiveThreshold) {
      this.silence = 0;
      if (!this._speaking) {
        // Онсет-дебаунс: speech_start только после onsetFrames подряд громких кадров —
        // одиночный щелчок/шум не будит цикл (анти-дребезг, иначе флуд speech_start/end).
        this.voiced += 1;
        if (this.voiced >= this.config.onsetFrames) {
          this._speaking = true;
          this.voiced = 0;
          this.speechFrames = 0;
          this.energyAcc = 0;
          return "speech_start";
        }
        return null;
      }
      // Б5 (форензика 2026-07-10): «речь» дольше потолка = не речь, а громкий ФОН (игра из колонок).
      // Форсим speech_end и поднимаем порог под этот фон — иначе ход не финализируется часами и
      // команды тонут. Порог спадает обратно на тихих кадрах (см. ниже) — слух возвращается сам.
      this.speechFrames += 1;
      this.energyAcc += energy;
      if (this.config.maxSpeechFrames > 0 && this.speechFrames >= this.config.maxSpeechFrames) {
        const avg = this.energyAcc / this.speechFrames;
        this.adaptive = avg * 1.15;
        log.warn("VAD: «речь» дольше потолка — форс speech_end + адаптивный порог под фон", {
          frames: this.speechFrames,
          avgEnergy: Math.round(avg),
          newThreshold: Math.round(this.adaptive),
        });
        this._speaking = false;
        this.silence = 0;
        this.speechFrames = 0;
        this.energyAcc = 0;
        return "speech_end";
      }
      return null;
    }
    // тихий кадр — прерывает накопление онсета (нужны именно ПОДРЯД идущие громкие кадры)
    this.voiced = 0;
    // Спад адаптивного порога (ревью 2026-07-10, симуляция): раньше спад ×0.995 шёл на ЛЮБОМ кадре
    // ниже effective-порога — включая ГРОМКИЙ фон ниже adaptive → порог сползал под фон за ~0.7с и
    // «вечная речь» возвращалась циклами по 20с. Теперь: быстрый спад ТОЛЬКО на истинно тихих кадрах
    // (< базового порога — фон реально стих); в полосе «выше базы, ниже adaptive» — черепаший
    // (×0.9999: пока громкий фон продолжается, порог ОБЯЗАН держаться над ним).
    if (this.adaptive > 0) {
      this.adaptive *= energy < this.config.threshold ? 0.995 : 0.9999;
      if (this.adaptive <= this.config.threshold) this.adaptive = 0;
    }
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
    this.voiced = 0;
    this.speechFrames = 0;
    this.energyAcc = 0;
    this.adaptive = 0;
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
