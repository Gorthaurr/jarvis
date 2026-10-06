/** PCM 16-bit LE → нормализованный Float32 [-1,1] для Whisper. */
export function pcm16ToFloat32(u8: Uint8Array): Float32Array {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = Math.floor(u8.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** BCP-47 → имя языка Whisper (transformers.js ждёт полное имя). */
export function whisperLang(code?: string): string {
  if (!code) return "russian";
  const c = code.toLowerCase();
  if (c.startsWith("ru")) return "russian";
  if (c.startsWith("en")) return "english";
  return c;
}

/** Минимум аудио для распознавания (байт). ~0.5с @16кГц 16-bit = 16000 байт. */
export const MIN_BYTES = 16_000;
/** Ниже этого ПИКА амплитуды считаем тишиной/шумом (Whisper там галлюцинирует «Спасибо»,
 *  «Продолжение следует» и т.п.). Реальная речь — пик 0.1–0.6, шум/эхо — <0.06. */
export const SILENCE_PEAK = 0.06;

/**
 * Нормализация громкости. КРИТИЧНО: гейт по ПИКУ, НЕ по среднему RMS — длинный буфер
 * (речь + хвост тишины) разбавлял средний RMS и реальная (особенно тихая) речь резалась
 * как «тишина». Тихий микрофон усиливаем до целевого пика, чтобы Whisper уверенно распознал.
 * Возвращает (возможно усиленный) сигнал и исходный пик амплитуды.
 */
export function normalizeAudio(audio: Float32Array, targetPeak = 0.3): { audio: Float32Array; peak: number } {
  let peak = 0;
  for (let i = 0; i < audio.length; i += 1) {
    const a = Math.abs(audio[i]!);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return { audio, peak }; // практически тишина — не усиливаем
  const gain = Math.min(4, targetPeak / peak); // кап ×4 (большое усиление раздувало шум → галлюцинации)
  if (gain <= 1.05) return { audio, peak }; // уже достаточно громко
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i += 1) out[i] = Math.max(-1, Math.min(1, audio[i]! * gain));
  return { audio: out, peak };
}

/**
 * Частые галлюцинации Whisper на тишине/шуме (обучен на ютуб-субтитрах) — дропаем,
 * иначе Джарвис «сходит с ума», отвечая на фантомные фразы.
 */
const HALLUCINATIONS: RegExp[] = [
  /субтитры?\b/i,
  /продолжение следует/i,
  /следующей серии/i,
  /смотрите продолжение/i,
  /спасибо за просмотр/i,
  /смотрите (на|в|это) видео/i,
  /подпис(ывайтесь|ка)/i,
  // ВНИМАНИЕ: НЕ добавлять сюда голые слова-подстроки вроде /редактор/ или /смешка/ —
  // они матчат ЖИВЫЕ команды («открой редактор», «текстовый редактор») и глушат речь.
  // Раньше так и было → Джарвис «не слышал» реальные просьбы. Денилист — только
  // характерные ютуб-фантомы Whisper целиком, не куски нормальных фраз.
  /^[\s.…!?,-]*$/,
  /^\(.*\)$/,
];
export function isNoise(text: string): boolean {
  const s = text.trim();
  if (s.length < 2) return true;
  if (s.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return true;
  return HALLUCINATIONS.some((re) => re.test(s));
}
