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

describe("EnergyVad — потолок «вечной речи» (Б5, форензика 2026-07-10: 39-минутный ход под звук игры)", () => {
  const CFG = { threshold: 700, hangoverFrames: 3, onsetFrames: 2, maxSpeechFrames: 10 };
  const BG = frame(2000); // громкий фон (игра из колонок)

  it("громкий фон дольше потолка → форс speech_end + адаптивный порог выше фона", () => {
    const vad = new EnergyVad(CFG);
    expect(vad.process(BG)).toBeNull();
    expect(vad.process(BG)).toBe("speech_start");
    let signal: string | null = null;
    for (let i = 0; i < CFG.maxSpeechFrames; i += 1) signal = vad.process(BG);
    expect(signal).toBe("speech_end"); // потолок финализировал ход — команда не тонет в «вечной речи»
    expect(vad.speaking).toBe(false);
    expect(vad.effectiveThreshold).toBeGreaterThan(2000); // порог перекалиброван ПОД фон (avg × 1.15)
    // Тот же фон больше НЕ считается речью (иначе следующий ход снова длился бы вечность).
    for (let i = 0; i < 5; i += 1) expect(vad.process(BG)).toBeNull();
    expect(vad.speaking).toBe(false);
  });

  it("адаптивный порог спадает на тихих кадрах — слух возвращается", () => {
    const vad = new EnergyVad(CFG);
    vad.process(BG);
    vad.process(BG);
    for (let i = 0; i < CFG.maxSpeechFrames; i += 1) vad.process(BG);
    expect(vad.effectiveThreshold).toBeGreaterThan(CFG.threshold);
    for (let i = 0; i < 400; i += 1) vad.process(QUIET); // полураспад ~3с → к базовому
    expect(vad.effectiveThreshold).toBe(CFG.threshold);
    vad.process(BG);
    expect(vad.process(BG)).toBe("speech_start"); // обычная речь снова детектится
  });

  it("ревью: ПРОДОЛЖАЮЩИЙСЯ громкий фон НЕ съедает адаптивный порог (нет циклов «вечной речи» по 20с)", () => {
    const vad = new EnergyVad(CFG);
    vad.process(BG);
    vad.process(BG);
    for (let i = 0; i < CFG.maxSpeechFrames; i += 1) vad.process(BG);
    const raised = vad.effectiveThreshold;
    expect(raised).toBeGreaterThan(2000);
    // Симуляция ревью: раньше 35 кадров фона (0.7с) роняли порог под фон → снова speech_start.
    for (let i = 0; i < 500; i += 1) vad.process(BG);
    expect(vad.speaking).toBe(false); // фон так и не стал «речью»
    expect(vad.effectiveThreshold).toBeGreaterThan(2000); // порог держится НАД фоном (спад ×0.9999)
  });

  it("обычная короткая речь потолка не касается; maxSpeechFrames=0 — потолок выключен", () => {
    const vad = new EnergyVad(CFG);
    vad.process(BG);
    vad.process(BG);
    vad.process(QUIET);
    vad.process(QUIET);
    expect(vad.process(QUIET)).toBe("speech_end"); // штатный hangover
    expect(vad.effectiveThreshold).toBe(CFG.threshold); // порог не тронут
    const off = new EnergyVad({ ...CFG, maxSpeechFrames: 0 });
    off.process(BG);
    off.process(BG);
    for (let i = 0; i < 100; i += 1) expect(off.process(BG)).toBeNull();
    expect(off.speaking).toBe(true); // прежнее поведение
  });
});
