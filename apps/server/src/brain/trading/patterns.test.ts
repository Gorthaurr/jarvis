import { describe, expect, it } from "vitest";
import { detectCandlePatterns, patternBias } from "./patterns.js";

const k = (o: number, h: number, l: number, c: number, v = 1) => ({ t: 0, o, h, l, c, v });

describe("patterns — свечные паттерны (§трейдинг price action)", () => {
  it("бычье поглощение: медвежья → бычья, перекрывает тело", () => {
    const r = detectCandlePatterns([k(10, 10.1, 8, 8), k(7.5, 11.1, 7.4, 11)]);
    expect(r.some((s) => s.bias === "bull" && /поглощ/.test(s.name))).toBe(true);
    expect(patternBias(r)).toBe("bull");
  });

  it("медвежье поглощение: бычья → медвежья, перекрывает", () => {
    const r = detectCandlePatterns([k(8, 10.1, 7.9, 10), k(10.5, 10.6, 7.4, 7.5)]);
    expect(r.some((s) => s.bias === "bear" && /поглощ/.test(s.name))).toBe(true);
  });

  it("молот: маленькое тело сверху, длинная нижняя тень → бычий", () => {
    const r = detectCandlePatterns([k(10, 10.2, 9.8, 10), k(10, 10.3, 9, 10.2)]);
    expect(r.some((s) => /молот/.test(s.name) && s.bias === "bull")).toBe(true);
  });

  it("падающая звезда: длинная верхняя тень → медвежий", () => {
    const r = detectCandlePatterns([k(10, 10.2, 9.8, 10), k(10, 11.2, 9.9, 10.1)]);
    expect(r.some((s) => /звезда/.test(s.name) && s.bias === "bear")).toBe(true);
  });

  it("доджи: крошечное тело → нейтрально", () => {
    const r = detectCandlePatterns([k(10, 10.2, 9.8, 10), k(10, 11, 9, 10.01)]);
    expect(r.some((s) => /доджи/.test(s.name) && s.bias === "neutral")).toBe(true);
  });

  it("обычные свечи без паттерна → пусто", () => {
    const r = detectCandlePatterns([k(10, 10.5, 9.5, 10.3), k(10.3, 10.8, 10.1, 10.6)]);
    expect(r.length).toBe(0);
  });
});
