import { describe, expect, it } from "vitest";
import { inQuietWindow, parseQuietWindow } from "./quiet-hours.js";

// Волна E: тихие часы несрочного ambient. Формат "23-9" / "23:30-08:15", окно через полночь.
describe("parseQuietWindow / inQuietWindow", () => {
  it("окно через полночь: '23-9' — ночь тихая, день нет", () => {
    const w = parseQuietWindow("23-9")!;
    expect(w).toEqual({ startMin: 23 * 60, endMin: 9 * 60 });
    expect(inQuietWindow(w, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 3, 0))).toBe(true);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 8, 59))).toBe(true);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 9, 0))).toBe(false); // конец окна НЕ включительно
    expect(inQuietWindow(w, new Date(2026, 0, 1, 12, 0))).toBe(false);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 22, 59))).toBe(false);
  });

  it("окно внутри суток: '9-18'", () => {
    const w = parseQuietWindow("9-18")!;
    expect(inQuietWindow(w, new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 8, 59))).toBe(false);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 18, 0))).toBe(false);
  });

  it("минуты: '23:30-08:15'", () => {
    const w = parseQuietWindow("23:30-08:15")!;
    expect(inQuietWindow(w, new Date(2026, 0, 1, 23, 29))).toBe(false);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 8, 14))).toBe(true);
    expect(inQuietWindow(w, new Date(2026, 0, 1, 8, 15))).toBe(false);
  });

  it("мусор/пусто/вырожденное → null (тихих часов нет), не падает", () => {
    for (const bad of [undefined, "", "  ", "abc", "25-9", "9-61:00", "9", "9-9", "9:00-9:00", "1-2-3"]) {
      expect(parseQuietWindow(bad)).toBeNull();
    }
  });
});
