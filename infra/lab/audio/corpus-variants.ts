/**
 * Преобразования базовых TTS-WAV в варианты корпуса — БЕЗ внешних ключей и без синтеза новых слов. Синтезировать новые
 * near-miss («Джаз/сервис/Джордж») без TTS-ключа нельзя, поэтому их роль играют: (1) настоящие neg_* корпуса (в них «джаз/джип/
 * Джордж/Джессика»), (2) срезы pos_* посреди слова («Джа», «Джар») — похожий звук, но не слово. Всё остальное — искажение
 * канала: громкость, шум комнаты, темп, потеря начала слова.
 */
import { mixRoom } from "./noise.js";
import { RATE, resample } from "./wav.js";

export function gain(x: Float32Array, g: number): Float32Array {
  return x.map((v) => Math.max(-1, Math.min(1, v * g))); // мик клиппит на ±1
}

/** Темп/тон: воспроизведение с другой частотой (0.9 — медленнее и ниже, 1.1 — быстрее и выше). */
export function speed(x: Float32Array, k: number): Float32Array {
  return resample(x, RATE, Math.round(RATE / k));
}

export const withRoom = (x: Float32Array, snrDb: number): Float32Array => mixRoom(x, snrDb);

/** Индекс начала речи: первый 20-мс кадр с rms > 8% от пика кадров. */
export function onset(x: Float32Array): number {
  const fr = 320;
  const rmsAt = (o: number): number => {
    let s = 0;
    for (let i = o; i < Math.min(o + fr, x.length); i += 1) s += (x[i] ?? 0) ** 2;
    return Math.sqrt(s / fr);
  };
  let peak = 0;
  for (let o = 0; o + fr <= x.length; o += fr) peak = Math.max(peak, rmsAt(o));
  for (let o = 0; o + fr <= x.length; o += fr) if (rmsAt(o) > peak * 0.08) return o;
  return 0;
}

/** Потеря начала слова: отрезаем `ms` мс речи ПОСЛЕ начала (слушатель включился на середине «Джарвис»). */
export function cutHead(x: Float32Array, ms: number): Float32Array {
  return x.slice(onset(x) + Math.round((ms / 1000) * RATE));
}

/** Только первые `ms` мс речи («Джа…» и всё, что дальше, не сказано): near-miss срезом. */
export function prefix(x: Float32Array, ms: number): Float32Array {
  const o = onset(x);
  return x.slice(Math.max(0, o - 160), o + Math.round((ms / 1000) * RATE));
}
