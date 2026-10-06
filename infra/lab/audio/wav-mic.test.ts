import { describe, expect, it } from "vitest";
import { FRAME, makeupCurve, micChain, shape, toFrames } from "./mic-model.js";
import { RATE, loadWav16k, parseWav, resample, wavFromPcm16 } from "./wav.js";

/** Стерео 24-бит 44,1 кГц с чанком LIST перед data — то, на чём ломается «срез 44 байта». */
function stereo24(rate: number, seconds: number, left: number, right: number): Buffer {
  const n = Math.round(rate * seconds);
  const data = Buffer.alloc(n * 6);
  for (let i = 0; i < n; i += 1) {
    data.writeIntLE(Math.round(left * 8_388_607), i * 6, 3);
    data.writeIntLE(Math.round(right * 8_388_607), i * 6 + 3, 3);
  }
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 6, 8);
  fmt.writeUInt16LE(6, 12);
  fmt.writeUInt16LE(24, 14);
  const chunk = (id: string, b: Buffer): Buffer => {
    const h = Buffer.alloc(8);
    h.write(id, 0, "ascii");
    h.writeUInt32LE(b.length, 4);
    return Buffer.concat([h, b, b.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", fmt), chunk("LIST", Buffer.from("INFOISFT\x05\x00\x00\x00lab\x00\x00", "binary")), chunk("data", data)]);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from(new Uint32Array([body.length]).buffer), body]);
}

describe("wav", () => {
  it("стерео 24-бит 44,1 кГц с LIST → 16 кГц mono: микс каналов и длина", () => {
    const x = loadWav16k(stereo24(44_100, 0.5, 0.5, -0.25));
    expect(Math.abs(x.length - 8000)).toBeLessThanOrEqual(1);
    expect(x[100]).toBeCloseTo(0.125, 3); // (0.5 + -0.25) / 2
  });

  it("16 кГц mono s16le не меняется, круг через wavFromPcm16 без потерь", () => {
    const pcm = Int16Array.from({ length: 1000 }, (_, i) => (i * 37) % 30000 - 15000);
    const w = parseWav(wavFromPcm16(pcm));
    expect(w.rate).toBe(RATE);
    expect(w.samples.length).toBe(1000);
    expect(Math.round(w.samples[5]! * 32768)).toBe(pcm[5]);
  });

  it("не WAV и неподдержанный формат — честная ошибка, а не тишина", () => {
    expect(() => parseWav(Buffer.from("ID3 это mp3, не wav, честно...."))).toThrow(/не WAV/u);
    const b = wavFromPcm16(new Int16Array(10));
    b.writeUInt16LE(85, 20); // формат MP3-в-WAV
    expect(() => parseWav(b)).toThrow(/не поддержан/u);
  });

  it("ресемпл вниз усредняет окно, вверх — интерполирует (длина ×коэффициент)", () => {
    expect(resample(new Float32Array(48_000).fill(0.3), 48_000, 16_000).length).toBe(16_000);
    expect(resample(new Float32Array(8000), 8000, 16_000).length).toBe(16_000);
  });
});

describe("тракт микрофона (renderer: tanh(6x) → Int16 → кадры)", () => {
  it("тихий мик усиливается ≈×6, громкий насыщается мягко < клипа", () => {
    const quiet = micChain(Float32Array.from({ length: 4000 }, (_, i) => 0.01 * Math.sin(i / 5)));
    const peak = Math.max(...quiet.map(Math.abs));
    expect(peak).toBeGreaterThan(1900);
    expect(peak).toBeLessThan(2000); // tanh(0.06)*32767 ≈ 1964
    const loud = micChain(new Float32Array(100).fill(0.5));
    expect(loud[0]).toBeGreaterThan(32_000);
    expect(loud[0]).toBeLessThan(32_767);
  });

  it("кривая — та же таблица 4096 точек, что micMakeupCurve; между узлами линейная интерполяция", () => {
    const c = makeupCurve();
    expect(c.length).toBe(4096);
    expect(c[0]).toBeCloseTo(Math.tanh(-6), 6);
    expect(shape(0)).toBeCloseTo(0, 3);
    expect(shape(2)).toBeCloseTo(Math.tanh(6), 6); // за пределами — крайнее значение
    expect(shape(0.1)).toBeCloseTo(Math.tanh(0.6), 3);
  });

  it("отрицательная полуволна масштабируется ×0x8000 как в worklet, preGain и makeup:false работают", () => {
    expect(micChain(Float32Array.of(-1), { makeup: false })[0]).toBe(-32768);
    expect(micChain(Float32Array.of(1), { makeup: false })[0]).toBe(32767);
    const a = micChain(Float32Array.of(0.01), { preGain: 10 })[0]!;
    const b = micChain(Float32Array.of(0.1))[0]!;
    expect(a).toBe(b);
  });

  it("кадры ровно по 320 сэмплов, хвост тишины 1 с ≥ 45 кадров пре-ролла", () => {
    const fr = toFrames(new Int16Array(16_000)); // 1 с речи
    expect(fr.every((f) => f.length === FRAME)).toBe(true);
    expect(fr.length).toBe(100); // 50 кадров речи + 50 хвоста
    expect(toFrames(new Int16Array(100), 0).length).toBe(1); // неполный кадр добит нулями
    expect(toFrames(new Int16Array(16_000), 1000).slice(50).every((f) => f.every((v) => v === 0))).toBe(true);
  });
});
