import { describe, expect, it } from "vitest";
import { type SpeedupConfig, adaptiveSpeed, speedupConfigFromEnv } from "./voice-providers.js";

// Фиксированный конфиг — тесты не зависят от env машины.
const CFG: SpeedupConfig = { enabled: true, max: 1.12, minChars: 90, fullChars: 280 };

const short = "Готово, сэр."; // ~12 симв
const medium = "А".repeat(185); // ровно посередине между 90 и 280
const long = "Б".repeat(400); // заметно длиннее full

describe("adaptiveSpeed — ускорение длинных фраз (запрос Антона)", () => {
  it("короткую фразу не ускоряет (= base)", () => {
    expect(adaptiveSpeed(short, 1.0, CFG)).toBe(1.0);
    expect(adaptiveSpeed(short, 0.95, CFG)).toBe(0.95);
  });

  it("ровно на пороге minChars — ещё база", () => {
    expect(adaptiveSpeed("в".repeat(90), 1.0, CFG)).toBe(1.0);
  });

  it("длинную фразу (≥fullChars) ускоряет до base*max", () => {
    expect(adaptiveSpeed(long, 1.0, CFG)).toBeCloseTo(1.12, 5);
    expect(adaptiveSpeed(long, 0.95, CFG)).toBeCloseTo(0.95 * 1.12, 5);
  });

  it("среднюю фразу ускоряет частично (между base и base*max)", () => {
    const s = adaptiveSpeed(medium, 1.0, CFG);
    expect(s).toBeGreaterThan(1.0);
    expect(s).toBeLessThan(1.12);
    // 185 символов = (185-90)/(280-90)=0.5 → 1 + 0.12*0.5 = 1.06
    expect(s).toBeCloseTo(1.06, 5);
  });

  it("монотонно растёт с длиной", () => {
    const a = adaptiveSpeed("я".repeat(120), 1.0, CFG);
    const b = adaptiveSpeed("я".repeat(200), 1.0, CFG);
    const c = adaptiveSpeed("я".repeat(300), 1.0, CFG);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("длиннее fullChars не ускоряет сверх max (кап)", () => {
    expect(adaptiveSpeed("я".repeat(10_000), 1.0, CFG)).toBeCloseTo(1.12, 5);
  });

  it("enabled=false → всегда base", () => {
    const off: SpeedupConfig = { ...CFG, enabled: false };
    expect(adaptiveSpeed(long, 1.0, off)).toBe(1.0);
  });

  it("max=1 (выключено через множитель) → всегда base", () => {
    const flat: SpeedupConfig = { ...CFG, max: 1 };
    expect(adaptiveSpeed(long, 1.0, flat)).toBe(1.0);
  });

  it("длину меряет по trim (пробелы по краям не считаются)", () => {
    const padded = `   ${short}   `;
    expect(adaptiveSpeed(padded, 1.0, CFG)).toBe(1.0);
  });
});

describe("speedupConfigFromEnv — дефолты и env", () => {
  it("дефолты: включено, max 1.12, окно 90..280", () => {
    const c = speedupConfigFromEnv();
    expect(c.enabled).toBe(true);
    expect(c.max).toBeCloseTo(1.12, 5);
    expect(c.minChars).toBe(90);
    expect(c.fullChars).toBe(280);
  });

  it("JARVIS_TTS_SPEEDUP=0 выключает", () => {
    const prev = process.env.JARVIS_TTS_SPEEDUP;
    process.env.JARVIS_TTS_SPEEDUP = "0";
    try {
      expect(speedupConfigFromEnv().enabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.JARVIS_TTS_SPEEDUP;
      else process.env.JARVIS_TTS_SPEEDUP = prev;
    }
  });

  it("fullChars всегда > minChars (защита от деления на ноль)", () => {
    const prevMin = process.env.JARVIS_TTS_SPEEDUP_MIN_CHARS;
    const prevFull = process.env.JARVIS_TTS_SPEEDUP_FULL_CHARS;
    process.env.JARVIS_TTS_SPEEDUP_MIN_CHARS = "100";
    process.env.JARVIS_TTS_SPEEDUP_FULL_CHARS = "50"; // намеренно меньше min
    try {
      const c = speedupConfigFromEnv();
      expect(c.fullChars).toBeGreaterThan(c.minChars);
    } finally {
      if (prevMin === undefined) delete process.env.JARVIS_TTS_SPEEDUP_MIN_CHARS;
      else process.env.JARVIS_TTS_SPEEDUP_MIN_CHARS = prevMin;
      if (prevFull === undefined) delete process.env.JARVIS_TTS_SPEEDUP_FULL_CHARS;
      else process.env.JARVIS_TTS_SPEEDUP_FULL_CHARS = prevFull;
    }
  });
});
