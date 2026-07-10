import { describe, expect, it } from "vitest";
import { selectTtsModel } from "./elevenlabs.js";

const RICH = "eleven_v3";
const FAST = "eleven_flash_v2_5";

describe("selectTtsModel — гибрид скорость/качество (§10)", () => {
  it("короткий ack без тега → быстрая модель (мгновенный звук)", () => {
    expect(selectTtsModel("Готово.", RICH, FAST, 64)).toBe(FAST);
    expect(selectTtsModel("Я здесь, сэр. Чем могу быть полезен?", RICH, FAST, 64)).toBe(FAST);
  });

  it("содержательный (длинный) ответ → выразительная rich-модель", () => {
    const long =
      "Сегодня переменная облачность, днём около двадцати градусов, к вечеру возможен небольшой дождь — зонт не помешает.";
    expect(selectTtsModel(long, RICH, FAST, 64)).toBe(RICH);
  });

  it("короткий, но С интонац-тегом → rich (эмоция важнее скорости; быстрая теги не понимает)", () => {
    expect(selectTtsModel("[warmly] Рад видеть вас, сэр.", RICH, FAST, 64)).toBe(RICH);
  });

  it("maxChars=0 выключает гибрид → всегда rich", () => {
    expect(selectTtsModel("Готово.", RICH, FAST, 0)).toBe(RICH);
  });
});
