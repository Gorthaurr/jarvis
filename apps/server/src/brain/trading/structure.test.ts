import { describe, expect, it } from "vitest";
import { analyzeStructure } from "./structure.js";

/** Зигзаг с ЧЁТКИМИ изолированными свингами: пик каждые 4 бара (i%4==2), впадина (i%4==0); центр дрейфует. */
function zigzag(n: number, rising: boolean) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const center = rising ? 100 + i * 0.6 : 130 - i * 0.6;
    let h = center + 1;
    let l = center - 1;
    if (i % 4 === 2) h = center + 5; // изолированный пик
    if (i % 4 === 0) l = center - 5; // изолированная впадина
    out.push({ t: i, o: center, h, l, c: center, v: 1 });
  }
  return out;
}

describe("structure — структура рынка (§трейдинг)", () => {
  it("мало баров → range + честное описание", () => {
    const s = analyzeStructure([1, 2, 3, 4].map((c, i) => ({ t: i, o: c, h: c, l: c, c, v: 1 })));
    expect(s.trend).toBe("range");
    expect(s.desc).toMatch(/недостаточно|диапазон/);
  });

  it("восходящий зигзаг (HH/HL) → up; поддержка ниже цены", () => {
    const s = analyzeStructure(zigzag(16, true));
    expect(s.trend).toBe("up");
    if (s.support != null) expect(s.support).toBeLessThan(zigzag(16, true)[15]!.c);
  });

  it("нисходящий зигзаг (LH/LL) → down", () => {
    const s = analyzeStructure(zigzag(16, false));
    expect(s.trend).toBe("down");
  });

  it("всегда валидный тренд и непустое описание на достаточных данных", () => {
    const s = analyzeStructure(Array.from({ length: 40 }, (_, i) => {
      const c = 100 + Math.sin(i / 3) * 5;
      return { t: i, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 };
    }));
    expect(["up", "down", "range"]).toContain(s.trend);
    expect(s.desc.length).toBeGreaterThan(0);
  });
});
