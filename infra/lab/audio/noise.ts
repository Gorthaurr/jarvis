/**
 * Сгенерированный фон для проверки «слух молчит»: тишина / шум комнаты / «телевизор». Без внешних файлов и ключей,
 * детерминированно (seed). Уровни заданы в СЫРОМ мике (до makeup ×6), как у живого микрофона: комната ≈ 0,001 rms
 * (после кривой ≈ 240 int16 — ниже порога энерго-VAD 700), телевизор ≈ 0,008 rms речеподобной «болтовни» — слух не
 * должен принять её за «Джарвис». ТВ-речь синтетическая (вокализованный источник через три резонатора-форманты с слоговой
 * огибающей): настоящих слов в ней нет, поэтому это проверка на ложные срабатывания по ЗВУКУ, а не по смыслу.
 */
import { RATE } from "./wav.js";

export type NoiseKind = "silence" | "room" | "tv";

/** mulberry32: маленький детерминированный ГСЧ. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Розоватый шум комнаты: белый через одиночный НЧ-фильтр + гул сети 50 Гц. */
function room(n: number, rand: () => number, level: number): Float32Array {
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    lp += 0.15 * ((rand() * 2 - 1) - lp);
    out[i] = lp * 2.2 + 0.25 * Math.sin((2 * Math.PI * 50 * i) / RATE);
  }
  return scaleRms(out, level);
}

interface Formant {
  y1: number;
  y2: number;
  a1: number;
  a2: number;
  g: number;
}

function resonator(f: number, bw: number): Formant {
  const r = Math.exp((-Math.PI * bw) / RATE);
  const th = (2 * Math.PI * f) / RATE;
  return { y1: 0, y2: 0, a1: 2 * r * Math.cos(th), a2: -r * r, g: 1 - r };
}
const step = (s: Formant, x: number): number => {
  const y = s.g * x + s.a1 * s.y1 + s.a2 * s.y2;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
};
const VOWELS: Array<[number, number, number]> = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410]];

/** Речеподобная болтовня: слоги ~4/с, фразы с паузами, f0 110–220 Гц с вибрато. */
function babble(n: number, rand: () => number, level: number): Float32Array {
  const out = new Float32Array(n);
  const syl = Math.round(RATE / 4);
  let phase = 0;
  let filters = VOWELS[0]!.map((f) => resonator(f, 90));
  for (let i = 0; i < n; i += 1) {
    if (i % syl === 0) {
      const v = VOWELS[Math.floor(rand() * VOWELS.length)]!;
      filters = v.map((f) => resonator(f * (0.9 + 0.2 * rand()), 90));
    }
    const t = i / RATE;
    const inSyl = (i % syl) / syl;
    const paused = Math.floor(t / 1.6) % 3 === 2 && t % 1.6 > 0.6; // паузы между «фразами»
    const env = paused ? 0 : Math.sin(Math.PI * inSyl) ** 1.5;
    const f0 = 165 + 55 * Math.sin(2 * Math.PI * 0.35 * t) + 4 * Math.sin(2 * Math.PI * 5.5 * t);
    phase += f0 / RATE;
    phase -= Math.floor(phase);
    const src = (phase < 0.08 ? 1 : 0) - 0.08 + 0.02 * (rand() - 0.5); // импульсы гортани
    let y = 0;
    for (const f of filters) y += step(f, src);
    out[i] = y * env;
  }
  return scaleRms(out, level);
}

function scaleRms(x: Float32Array, target: number): Float32Array {
  let s = 0;
  for (const v of x) s += v * v;
  const cur = Math.sqrt(s / Math.max(1, x.length));
  const k = cur > 0 ? target / cur : 0;
  for (let i = 0; i < x.length; i += 1) x[i] = (x[i] ?? 0) * k;
  return x;
}

/** ms мс фона в «сыром» float (подаётся в micChain как обычный мик). */
export function makeNoise(kind: NoiseKind, ms: number, seed = 1, level?: number): Float32Array {
  const n = Math.round((ms / 1000) * RATE);
  const rand = rng(seed);
  if (kind === "silence") return new Float32Array(n);
  if (kind === "room") return room(n, rand, level ?? 0.001);
  return babble(n, rand, level ?? 0.008); // громче (≈0,012) пик после makeup ≥6000 — законный кандидат подстраховки
}

/** Подмешать шум комнаты к сигналу под заданный SNR (дБ) — для корпусных вариантов. */
export function mixRoom(sig: Float32Array, snrDb: number, seed = 7): Float32Array {
  let s = 0;
  for (const v of sig) s += v * v;
  const sigRms = Math.sqrt(s / Math.max(1, sig.length));
  const noise = room(sig.length, rng(seed), sigRms / 10 ** (snrDb / 20));
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i += 1) out[i] = (sig[i] ?? 0) + (noise[i] ?? 0);
  return out;
}
