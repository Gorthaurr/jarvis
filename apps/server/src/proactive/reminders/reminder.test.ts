import { describe, expect, it } from "vitest";
import { describeWhen, resolveFireAt } from "./reminder.js";

const NOW = Date.parse("2026-06-18T12:00:00Z");

describe("resolveFireAt — сервер считает абсолютный момент", () => {
  it("delay_seconds → now + N сек", () => {
    expect(resolveFireAt({ delaySeconds: 15 }, NOW)).toEqual({ fireAt: NOW + 15_000 });
    expect(resolveFireAt({ delaySeconds: 600 }, NOW)).toEqual({ fireAt: NOW + 600_000 });
  });

  it("at (ISO, будущее) → распарсенный момент", () => {
    const res = resolveFireAt({ at: "2026-06-18T13:00:00Z" }, NOW);
    expect(res).toEqual({ fireAt: Date.parse("2026-06-18T13:00:00Z") });
  });

  it("ошибки: пусто / оба / <1 / прошлое / кривой ISO", () => {
    expect("error" in resolveFireAt({}, NOW)).toBe(true);
    expect("error" in resolveFireAt({ delaySeconds: 10, at: "2026-06-18T13:00:00Z" }, NOW)).toBe(true);
    expect("error" in resolveFireAt({ delaySeconds: 0 }, NOW)).toBe(true);
    expect("error" in resolveFireAt({ at: "2020-01-01T00:00:00Z" }, NOW)).toBe(true); // прошлое
    expect("error" in resolveFireAt({ at: "не дата" }, NOW)).toBe(true);
  });

  it("слишком далеко (> года) → ошибка", () => {
    expect("error" in resolveFireAt({ delaySeconds: 400 * 24 * 3600 }, NOW)).toBe(true);
  });
});

describe("describeWhen — человеко-описание для подтверждения", () => {
  it("секунды/минуты/часы/дни", () => {
    expect(describeWhen(NOW + 15_000, NOW)).toBe("через 15 сек");
    expect(describeWhen(NOW + 120_000, NOW)).toBe("через 2 мин");
    expect(describeWhen(NOW + 2 * 3600_000, NOW)).toBe("через 2 ч");
    expect(describeWhen(NOW + 3 * 24 * 3600_000, NOW)).toBe("через 3 дн");
  });
});
