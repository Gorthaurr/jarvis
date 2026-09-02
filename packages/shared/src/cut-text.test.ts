import { describe, expect, it } from "vitest";
import { cutText } from "./index.js";

describe("cutText — усечение без разрыва суррогатной пары", () => {
  it("короткая строка возвращается как есть", () => {
    expect(cutText("привет", 10)).toBe("привет");
  });
  it("обычное усечение по код-юнитам", () => {
    expect(cutText("abcdef", 3)).toBe("abc");
  });
  it("эмодзи на границе не режется пополам (одинокий high-surrogate невалиден в JSON запроса)", () => {
    const s = "ab😀cd"; // 😀 = 😀
    const cut = cutText(s, 3); // граница внутри пары
    expect(cut).toBe("ab");
    expect(/[\ud800-\udbff]$/u.test(cut)).toBe(false);
    expect(cutText(s, 4)).toBe("ab😀"); // пара целиком помещается
  });
});
