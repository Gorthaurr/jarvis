// Волна H (шаг 1): возраст факта в доверенном блоке промпта — свежесть считает КОД, не модель.
import { describe, expect, it } from "vitest";
import { factAgeLabel, withFactAges } from "./fact-age.js";

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0); // 31 августа 2026
const day = 86_400_000;

describe("factAgeLabel", () => {
  it("свежие — короткими словами", () => {
    expect(factAgeLabel(NOW - 3600_000, NOW)).toBe("сегодня");
    expect(factAgeLabel(NOW - day, NOW)).toBe("вчера");
    expect(factAgeLabel(NOW - 3 * day, NOW)).toBe("3 дн. назад");
    expect(factAgeLabel(NOW - 10 * day, NOW)).toBe("на прошлой неделе");
  });

  it("старые — месяцем, за пределами года — с годом", () => {
    expect(factAgeLabel(NOW - 60 * day, NOW)).toBe("с июля");
    expect(factAgeLabel(NOW - 400 * day, NOW)).toBe("с июля 2025");
  });

  it("мусор и будущее → метки НЕТ (выдуманная дата хуже отсутствия)", () => {
    expect(factAgeLabel(0, NOW)).toBeUndefined();
    expect(factAgeLabel(Number.NaN, NOW)).toBeUndefined();
    expect(factAgeLabel(NOW + 10 * day, NOW)).toBeUndefined();
  });
});

describe("withFactAges", () => {
  it("размечает факты с метаданными и НЕ трогает легаси без них", () => {
    const facts = ["работает в Яндексе", "жена — Оля"];
    const meta = new Map([["работает в Яндексе", { ts: NOW - 2 * day }]]);
    expect(withFactAges(facts, meta, NOW)).toEqual(["(вчера) работает в Яндексе".replace("вчера", "2 дн. назад"), "жена — Оля"]);
  });

  it("порядок и состав фактов сохраняются (в промпт идёт то же множество)", () => {
    const facts = ["а", "б", "в"];
    const out = withFactAges(facts, new Map(), NOW);
    expect(out).toEqual(facts);
  });

  // 🔴 Смысл шага: два противоречащих факта различимы по свежести, и модель больше не выбирает наугад.
  it("противоречащая пара получает РАЗНЫЙ возраст", () => {
    const facts = ["работает в Сбере", "работает в Яндексе"];
    const meta = new Map([
      ["работает в Сбере", { ts: NOW - 300 * day }],
      ["работает в Яндексе", { ts: NOW - day }],
    ]);
    const [old, fresh] = withFactAges(facts, meta, NOW);
    expect(old).toContain("2025");
    expect(fresh).toContain("вчера");
  });
});
