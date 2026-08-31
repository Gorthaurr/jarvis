// Самоосмотр: редкая проактивная реплика «вот что у меня повторяется» (волна I, 2026-08-31).
import { describe, expect, it } from "vitest";
import { buildSelfReview, shouldSelfReview } from "./self-review.js";

const DAY = 24 * 60 * 60 * 1000;
const w = (title: string, count: number) => ({ kind: `degradation:${title}`, title, count, samples: [] });

describe("shouldSelfReview — редко и только когда уместно", () => {
  it("никогда не докладывали → пора", () => {
    expect(shouldSelfReview({ everyDays: 3, enabled: true }, Date.now())).toBe(true);
  });

  it("докладывали вчера при периоде 3 дня → рано", () => {
    const now = Date.now();
    expect(shouldSelfReview({ lastReviewedAt: now - DAY, everyDays: 3, enabled: true }, now)).toBe(false);
  });

  it("прошёл период → снова пора", () => {
    const now = Date.now();
    expect(shouldSelfReview({ lastReviewedAt: now - 4 * DAY, everyDays: 3, enabled: true }, now)).toBe(true);
  });

  it("выключено (dev-сессия / аварийный стоп) → молчим независимо от срока", () => {
    expect(shouldSelfReview({ everyDays: 3, enabled: false }, Date.now())).toBe(false);
  });
});

describe("buildSelfReview — честная формулировка", () => {
  it("нет повторяющихся слабостей → МОЛЧИМ (а не «у меня всё отлично»)", () => {
    expect(buildSelfReview([])).toBeNull();
    expect(buildSelfReview([w("разовый сбой", 1), w("ещё один", 2)])).toBeNull(); // единичное — шум
  });

  it("называет повторяющееся и предлагает разобраться, НЕ обещая результат", () => {
    const line = buildSelfReview([w("Поиск в вебе возвращал пустоту — 7 раз", 7)]) ?? "";
    expect(line).toContain("Поиск в вебе");
    expect(line).toContain("почини себя"); // владельцу названа команда
    expect(line).toMatch(/[Мм]огу разобраться/); // предложение
    expect(line).not.toMatch(/исправил|починил|устранил/); // ничего не сделано — обещать нечего
  });

  it("голос не заваливаем: две вещи вслух, остальное счётчиком", () => {
    const line = buildSelfReview([w("первое", 9), w("второе", 8), w("третье", 7), w("четвёртое", 6)]) ?? "";
    expect(line).toContain("первое");
    expect(line).toContain("второе");
    expect(line).not.toContain("третье");
    expect(line).toContain("И ещё 2");
  });
});
