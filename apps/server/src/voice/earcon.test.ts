import { describe, expect, it } from "vitest";
import { buildAckEarconWav, wrapWavPcm16 } from "./earcon.js";

describe("earcon приёмки (Волна 1, эпизод 2026-07-10)", () => {
  it("валидный WAV-контейнер: RIFF/WAVE/fmt/data, mono PCM16 24кГц", () => {
    const buf = buildAckEarconWav();
    const v = new DataView(buf);
    const str = (off: number, n: number): string =>
      Array.from({ length: n }, (_, j) => String.fromCharCode(v.getUint8(off + j))).join("");
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(str(12, 4)).toBe("fmt ");
    expect(str(36, 4)).toBe("data");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(24_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(4, true)).toBe(buf.byteLength - 8); // RIFF-размер сходится
    expect(v.getUint32(40, true)).toBe(buf.byteLength - 44); // data-размер сходится
  });

  it("короткий (~160мс), слышимый, без клиппинга — индикатор, не сигнализация", () => {
    const buf = buildAckEarconWav();
    const pcm = new Int16Array(buf, 44);
    const durMs = (pcm.length / 24_000) * 1000;
    expect(durMs).toBeGreaterThan(120);
    expect(durMs).toBeLessThan(220);
    let peak = 0;
    for (const s of pcm) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(3000); // не тишина
    expect(peak).toBeLessThan(0.4 * 32767); // негромко, без клиппинга
    // Края — с огибающей (нет щелчка на старте/финише).
    expect(Math.abs(pcm[0] ?? 0)).toBeLessThan(500);
    expect(Math.abs(pcm[pcm.length - 1] ?? 0)).toBeLessThan(500);
  });

  it("wrapWavPcm16 честно считает размеры для произвольного PCM", () => {
    const pcm = new Int16Array([0, 1000, -1000, 0]);
    const buf = wrapWavPcm16(pcm, 16_000);
    expect(buf.byteLength).toBe(44 + 8);
    expect(new DataView(buf).getUint32(24, true)).toBe(16_000);
    expect(Array.from(new Int16Array(buf, 44))).toEqual([0, 1000, -1000, 0]);
  });
});
