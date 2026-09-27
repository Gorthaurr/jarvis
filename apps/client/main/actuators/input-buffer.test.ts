/** W2 (пакет 0): буфер набранного — pendingText для вопроса владельцу и склейка цифр для Луны по кускам. */
import { describe, expect, it } from "vitest";
import { InputBuffer } from "./input-buffer.js";

describe("InputBuffer", () => {
  it("recent — хвост набранного через куски; reset — новая эпоха фокуса", () => {
    const b = new InputBuffer();
    b.append("привет, ");
    b.append("Катя");
    expect(b.recent()).toBe("привет, Катя");
    expect(b.recent(4)).toBe("Катя");
    const e = b.epoch;
    b.reset();
    expect(b.recent()).toBe("");
    expect(b.epoch).toBe(e + 1);
  });

  it("digits склеивает номер карты из кусков («4276 1600» + « 1234 5678»), буква рвёт хвост", () => {
    const b = new InputBuffer();
    b.append("4276 1600");
    b.append(" 1234 5678");
    expect(b.digits()).toBe("4276 1600 1234 5678");
    b.append(" рублей 42");
    expect(b.digits()).toBe(" 42");
    expect(b.digits(2)).toBe("42");
  });

  it("кап текста; время последней печати", () => {
    const b = new InputBuffer();
    b.append("x".repeat(1000), 5);
    expect(b.recent(10_000).length).toBe(400);
    expect(b.lastAppendAt).toBe(5);
  });
});
