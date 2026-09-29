/**
 * WAV-ридер/писатель аудио-стенда. Читает RIFF ПО ЧАНКАМ (а не срезом 44 байта, как sherpa-hearing.test.ts): у файлов
 * с `LIST`/`fact` перед `data` срез по фиксированному смещению даёт мусор. Любой формат (8/16/24/32 бит, float32, N каналов,
 * любая частота) приводится к тракту клиента: 16 кГц mono s16le. Не-WAV или неподдержанное — честная ошибка, не тишина.
 */
import { readFileSync } from "node:fs";

export const RATE = 16_000;

export interface WavInfo {
  rate: number;
  channels: number;
  bits: number;
  format: number;
  /** Сэмплы (микс каналов), float [-1..1], в ИСХОДНОЙ частоте. */
  samples: Float32Array;
}

export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("не WAV (нет RIFF/WAVE)");
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size)); // потоковый WAV: size может врать — режем по файлу
    if (id === "fmt ") fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === "data") {
      data = body;
      break;
    }
    p += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV без fmt/data");
  let format = fmt.format;
  if (format === 0xfffe) format = fmt.bits === 32 || fmt.bits === 64 ? 3 : 1; // EXTENSIBLE: PCM/float по разрядности (эвристика)
  if (format !== 1 && format !== 3) throw new Error(`формат WAV ${fmt.format} не поддержан (только PCM/float)`);
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c += 1) acc += readSample(data, (i * fmt.channels + c) * bytes, fmt.bits, format);
    out[i] = acc / fmt.channels;
  }
  return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, format, samples: out };
}

function readSample(d: Buffer, o: number, bits: number, format: number): number {
  if (format === 3) return bits === 64 ? d.readDoubleLE(o) : d.readFloatLE(o);
  if (bits === 8) return ((d[o] ?? 128) - 128) / 128;
  if (bits === 16) return d.readInt16LE(o) / 32768;
  if (bits === 24) return d.readIntLE(o, 3) / 8_388_608;
  if (bits === 32) return d.readInt32LE(o) / 2_147_483_648;
  throw new Error(`разрядность ${bits} не поддержана`);
}

/** Ресемпл: вниз — усреднение окна (грубый анти-алиасинг), вверх — линейная интерполяция. Для проверки слуха достаточно. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i += 1) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    if (ratio > 1) {
      const b = Math.min(x.length, Math.max(a + 1, Math.floor(pos + ratio)));
      let s = 0;
      for (let j = a; j < b; j += 1) s += x[j] ?? 0;
      out[i] = s / (b - a);
    } else {
      const f = pos - a;
      out[i] = (x[a] ?? 0) * (1 - f) + (x[Math.min(a + 1, x.length - 1)] ?? 0) * f;
    }
  }
  return out;
}

/** Файл/буфер WAV → float [-1..1] на 16 кГц mono (вход тракта «микрофон»). */
export function loadWav16k(src: Buffer | string): Float32Array {
  const w = parseWav(typeof src === "string" ? readFileSync(src) : src);
  return resample(w.samples, w.rate, RATE);
}

export function floatToPcm16(x: Float32Array): Int16Array {
  const o = new Int16Array(x.length);
  for (let i = 0; i < x.length; i += 1) {
    const s = Math.max(-1, Math.min(1, x[i] ?? 0));
    o[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return o;
}

/** PCM16 mono → WAV-файл (сохранение озвучки pcm16 и корпуса). */
export function wavFromPcm16(pcm: Int16Array, rate = RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
