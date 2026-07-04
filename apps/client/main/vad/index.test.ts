import { describe, expect, it } from "vitest";
import { DEFAULT_VAD_CONFIG, EnergyVad, rms } from "./index.js";

/** Кадр постоянной амплитуды: RMS = |value|, удобно гонять порог/онсет. */
function frame(value: number, n = 160): Int16Array {
  return new Int16Array(n).fill(value);
}

const LOUD = frame(1000); // rms 1000 > threshold 700
const QUIET = frame(0);

describe("EnergyVad (§3/§10)", () => {
  it("rms: постоянная амплитуда → её модуль", () => {
    expect(rms(frame(1000))).toBeCloseTo(1000);
    expect(rms(QUIET)).toBe(0);
    expect(rms(new Int16Array(0))).toBe(0);
  });

  it("онсет-дебаунс: одиночный громкий кадр НЕ будит речь", () => {
    const vad = new EnergyVad();
    expect(vad.process(LOUD)).toBeNull(); // 1/3 — рано
    expect(vad.process(QUIET)).toBeNull(); // тишина обнулила накопление
    expect(vad.speaking).toBe(false);
  });

  it("speech_start только после onsetFrames подряд громких кадров", () => {
    const vad = new EnergyVad();
    expect(vad.process(LOUD)).toBeNull(); // 1
    expect(vad.process(LOUD)).toBeNull(); // 2
    expect(vad.process(LOUD)).toBe("speech_start"); // 3 → онсет
    expect(vad.speaking).toBe(true);
    // Уже в речи — следующие громкие кадры событий не плодят.
    expect(vad.process(LOUD)).toBeNull();
  });

  it("прерывание тишиной сбрасывает онсет (нужны именно ПОДРЯД)", () => {
    const vad = new EnergyVad();
    vad.process(LOUD);
    vad.process(LOUD); // 2 подряд
    expect(vad.process(QUIET)).toBeNull(); // сброс
    vad.process(LOUD);
    vad.process(LOUD);
    expect(vad.speaking).toBe(false); // только 2 подряд после сброса — ещё не речь
    expect(vad.process(LOUD)).toBe("speech_start"); // 3-й подряд
  });

  it("speech_end после hangoverFrames тишины", () => {
    const vad = new EnergyVad();
    for (let i = 0; i < DEFAULT_VAD_CONFIG.onsetFrames; i += 1) vad.process(LOUD);
    expect(vad.speaking).toBe(true);
    // hangover-1 тихих кадров — ещё говорит, затем граничный кадр даёт speech_end.
    for (let i = 0; i < DEFAULT_VAD_CONFIG.hangoverFrames - 1; i += 1) {
      expect(vad.process(QUIET)).toBeNull();
    }
    expect(vad.process(QUIET)).toBe("speech_end");
    expect(vad.speaking).toBe(false);
  });

  it("reset обнуляет состояние", () => {
    const vad = new EnergyVad();
    vad.process(LOUD);
    vad.process(LOUD);
    vad.reset();
    // После reset снова нужны полные onsetFrames подряд.
    vad.process(LOUD);
    vad.process(LOUD);
    expect(vad.speaking).toBe(false);
    expect(vad.process(LOUD)).toBe("speech_start");
  });
});
