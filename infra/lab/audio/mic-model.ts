/**
 * Модель тракта «микрофон → кадры main-процесса» — как renderer/audio.ts + audio-worklet.js, но без DOM.
 * Порядок тот же: float → pre-gain (уровень сырого мика) → WaveShaper tanh(6x) → клип ±1 → Int16 (`s<0 ? s*0x8000 : s*0x7fff`)
 * → кадры по 320 сэмплов (20 мс) → хвост тишины. micMakeupCurve в renderer НЕ экспортирована и зависит от DOM, поэтому
 * воспроизведена здесь; интерполяция таблицы — линейная, как у WebAudio WaveShaperNode (oversample 4x не моделируем: разница
 * только в алиасинге насыщения). ВАЖНО про уровень: живой мик отдаёт пик 0,01–0,04, а корпусные TTS-WAV нормализованы
 * (0,5–0,9) — tanh(6x) на них насыщается, чего в жизни нет. Поэтому `preGain` — явная ручка, а не молчаливая подгонка.
 */
import { RATE, floatToPcm16 } from "./wav.js";

export const FRAME = 320;
export const FRAME_MS = 20;
export const MIC_MAKEUP_GAIN = 6;
const CURVE_N = 4096;

let curve: Float32Array | null = null;

/** Та же таблица, что micMakeupCurve() в renderer (k=6, n=4096). */
export function makeupCurve(k = MIC_MAKEUP_GAIN, n = CURVE_N): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i += 1) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1));
  return c;
}

/** WaveShaper: вход −1..1 → линейная интерполяция по таблице; за пределами — крайние значения. */
export function shape(x: number): number {
  curve ??= makeupCurve();
  const n = curve.length;
  if (x <= -1) return curve[0] ?? -1;
  if (x >= 1) return curve[n - 1] ?? 1;
  const v = ((x + 1) / 2) * (n - 1);
  const i = Math.floor(v);
  const f = v - i;
  return (curve[i] ?? 0) * (1 - f) + (curve[i + 1] ?? curve[i] ?? 0) * f;
}

export interface MicOptions {
  /** Множитель сырого сигнала ДО кривой (уровень «микрофона»); 1 = WAV как есть. */
  preGain?: number;
  /** false — без makeup-кривой (для сравнения). */
  makeup?: boolean;
}

/** Float-поток «сырого микрофона» → Int16, какой получает AudioCoordinator.ingest(). */
export function micChain(raw: Float32Array, opts: MicOptions = {}): Int16Array {
  const g = opts.preGain ?? 1;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const x = Math.max(-1, Math.min(1, (raw[i] ?? 0) * g)); // мик сам клиппит на ±1
    out[i] = opts.makeup === false ? x : shape(x);
  }
  return floatToPcm16(out);
}

/**
 * Нарезка на кадры по 320 сэмплов. Хвост тишины по умолчанию 1000 мс — не косметика: после промаха KWS кольцо пре-ролла
 * (45 кадров = 0,9 с) остаётся заполненным звуком реплики, а публичного «очистить» у координатора нет; ≥0,9 с тишины
 * вымывают его. Silero тоже нужна тишина ≥0,25 с, чтобы отдать speech_end. Неполный последний кадр добиваем нулями.
 */
export function toFrames(pcm: Int16Array, tailSilenceMs = 1000): Int16Array[] {
  const tail = Math.round((tailSilenceMs / 1000) * RATE);
  const padded = new Int16Array(Math.ceil((pcm.length + tail) / FRAME) * FRAME);
  padded.set(pcm);
  const frames: Int16Array[] = [];
  for (let o = 0; o < padded.length; o += FRAME) frames.push(padded.subarray(o, o + FRAME));
  return frames;
}
