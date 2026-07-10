/**
 * Earcon приёмки (Волна 1, эпизод 2026-07-10): фоновая задача принята → мгновенный короткий ТОН
 * (~160мс) вместо 8с тишины, из-за которой пользователь повторял команду (вторая петля, $1.09).
 * Именно тон, НЕ фраза: «тихий финал» (запрет дворецких ack-фраз на каждый ход, ретро ButlerAcks)
 * не нарушается — звук-индикатор ≠ реплика. WAV PCM собирается на лету (без ассетов/кодеков);
 * клиентский плеер сниффит RIFF-магию и играет как audio/wav.
 */

const SAMPLE_RATE = 24_000;
const AMPLITUDE = 0.28; // негромко: индикатор, не сигнализация

/** Обернуть PCM16 в WAV-контейнер (mono). Чистая функция. */
export function wrapWavPcm16(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string): void => {
    for (let j = 0; j < s.length; j += 1) v.setUint8(off + j, s.charCodeAt(j));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // размер fmt-чанка (PCM)
  v.setUint16(20, 1, true); // формат: PCM
  v.setUint16(22, 1, true); // каналов: 1
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate (mono 16-bit)
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // бит на сэмпл
  writeStr(36, "data");
  v.setUint32(40, dataLen, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

/**
 * Короткий двухтоновый блип «принял» (A5 880Гц → E6 ~1319Гц, атака/затухание против щелчков).
 * ~160мс, ~7.7КБ WAV. Чистая функция (юнит-тест на контейнер/длительность).
 */
export function buildAckEarconWav(): ArrayBuffer {
  const segments: Array<{ freq: number; ms: number }> = [
    { freq: 880, ms: 70 },
    { freq: 1318.5, ms: 90 },
  ];
  const total = Math.round((SAMPLE_RATE * segments.reduce((n, s) => n + s.ms, 0)) / 1000);
  const pcm = new Int16Array(total);
  let i = 0;
  for (const seg of segments) {
    const n = Math.round((SAMPLE_RATE * seg.ms) / 1000);
    for (let k = 0; k < n && i < total; k += 1, i += 1) {
      const t = k / SAMPLE_RATE;
      // Огибающая: атака ~5мс, затухание ~10мс — сегменты стыкуются без щелчка.
      const env = Math.max(0, Math.min(1, k / 120, (n - k) / 240));
      pcm[i] = Math.round(Math.sin(2 * Math.PI * seg.freq * t) * AMPLITUDE * 32767 * env);
    }
  }
  return wrapWavPcm16(pcm, SAMPLE_RATE);
}
