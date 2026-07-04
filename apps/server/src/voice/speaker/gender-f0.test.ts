import { describe, expect, it } from "vitest";
import { detectGender, f0Stats, genderFromF0 } from "./gender-f0.js";

const SR = 16_000;

/** Синтетический звонкий сигнал: основной тон f0 + 2 гармоники (реалистичнее чистого синуса). */
function tone(f0: number, seconds: number, amp = 0.6): Int16Array {
  const n = Math.floor(SR * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    const v =
      Math.sin(2 * Math.PI * f0 * t) +
      0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.3 * Math.sin(2 * Math.PI * 3 * f0 * t);
    out[i] = Math.max(-32768, Math.min(32767, Math.round((v / 1.8) * amp * 32767)));
  }
  return out;
}

function noise(seconds: number, amp = 0.6): Int16Array {
  const n = Math.floor(SR * seconds);
  const out = new Int16Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // детерминированный псевдошум
    out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amp * 32767);
  }
  return out;
}

describe("gender-f0 — оценка F0 и пола (§3 цель №2)", () => {
  it("мужской тон ~120 Гц → F0≈120, пол male", () => {
    const { gender, medianF0Hz } = detectGender(tone(120, 0.5));
    expect(medianF0Hz).not.toBeNull();
    expect(medianF0Hz!).toBeGreaterThan(110);
    expect(medianF0Hz!).toBeLessThan(130);
    expect(gender).toBe("male");
  });

  it("женский тон ~220 Гц → F0≈220, пол female", () => {
    const { gender, medianF0Hz } = detectGender(tone(220, 0.5));
    expect(medianF0Hz!).toBeGreaterThan(208);
    expect(medianF0Hz!).toBeLessThan(232);
    expect(gender).toBe("female");
  });

  it("низкий мужской 95 Гц → male; высокий женский 250 Гц → female", () => {
    expect(detectGender(tone(95, 0.5)).gender).toBe("male");
    expect(detectGender(tone(250, 0.5)).gender).toBe("female");
  });

  it("без октавных ошибок: 110 Гц не уезжает в 55/220", () => {
    const f = detectGender(tone(110, 0.5)).medianF0Hz!;
    expect(f).toBeGreaterThan(100);
    expect(f).toBeLessThan(122);
  });

  it("мягкая зона 155-165 Гц → unknown (не гадаем на границе)", () => {
    expect(genderFromF0(160)).toBe("unknown");
    expect(genderFromF0(154)).toBe("male"); // ≤155
    expect(genderFromF0(166)).toBe("female"); // ≥165
  });

  it("шум → unvoiced → пол unknown", () => {
    const { gender, medianF0Hz } = detectGender(noise(0.5));
    expect(medianF0Hz).toBeNull();
    expect(gender).toBe("unknown");
  });

  it("тишина → unvoiced → unknown", () => {
    const { gender } = detectGender(new Int16Array(SR >> 1));
    expect(gender).toBe("unknown");
  });

  it("короткий фрагмент (< окна) → null медиана, без падения", () => {
    const s = f0Stats(new Int16Array(256));
    expect(s.medianHz).toBeNull();
    expect(s.voicedFrames).toBe(0);
  });

  it("высокая доля звонких окон на чистом тоне", () => {
    const s = f0Stats(tone(150, 0.5));
    expect(s.voicedRatio).toBeGreaterThan(0.8);
  });

  it("genderFromF0 граничные/мусорные значения", () => {
    expect(genderFromF0(null)).toBe("unknown");
    expect(genderFromF0(Number.NaN)).toBe("unknown");
    expect(genderFromF0(0)).toBe("unknown");
  });
});
