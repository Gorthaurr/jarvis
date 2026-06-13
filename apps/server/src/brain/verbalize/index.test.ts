/**
 * Тесты вербализатора (§21). Кейсы из спеки: время, валюта, числа, очистка markdown.
 */
import { describe, expect, it } from "vitest";
import {
  numberToWords,
  pluralRu,
  speakRubles,
  stripCodeBlocks,
  stripMarkdown,
  verbalize,
  verbalizeCurrency,
  verbalizePhones,
  verbalizeTime,
} from "./index.js";

describe("numberToWords", () => {
  it("базовые числа (мужской род)", () => {
    expect(numberToWords(0)).toBe("ноль");
    expect(numberToWords(1)).toBe("один");
    expect(numberToWords(2)).toBe("два");
    expect(numberToWords(21)).toBe("двадцать один");
    expect(numberToWords(100)).toBe("сто");
    expect(numberToWords(115)).toBe("сто пятнадцать");
    expect(numberToWords(999)).toBe("девятьсот девяносто девять");
  });

  it("женский род для единиц", () => {
    expect(numberToWords(1, "feminine")).toBe("одна");
    expect(numberToWords(2, "feminine")).toBe("две");
  });

  it("тысячи с согласованием разряда", () => {
    expect(numberToWords(1000)).toBe("одна тысяча");
    expect(numberToWords(2000)).toBe("две тысячи");
    expect(numberToWords(5000)).toBe("пять тысяч");
    expect(numberToWords(1500)).toBe("одна тысяча пятьсот");
    expect(numberToWords(21000)).toBe("двадцать одна тысяча");
  });

  it("миллионы", () => {
    expect(numberToWords(1_000_000)).toBe("один миллион");
    expect(numberToWords(2_000_000)).toBe("два миллиона");
  });
});

describe("pluralRu", () => {
  const forms: [string, string, string] = ["рубль", "рубля", "рублей"];
  it("выбирает правильную форму", () => {
    expect(pluralRu(1, forms)).toBe("рубль");
    expect(pluralRu(2, forms)).toBe("рубля");
    expect(pluralRu(5, forms)).toBe("рублей");
    expect(pluralRu(11, forms)).toBe("рублей");
    expect(pluralRu(21, forms)).toBe("рубль");
    expect(pluralRu(112, forms)).toBe("рублей");
  });
});

describe("verbalizeTime", () => {
  it("часы и минуты", () => {
    expect(verbalizeTime("в 8:20")).toBe("в восемь двадцать");
    expect(verbalizeTime("09:05")).toBe("девять ноль пять");
    expect(verbalizeTime("встреча в 14:30")).toBe("встреча в четырнадцать тридцать");
  });
  it("ровный час", () => {
    expect(verbalizeTime("8:00")).toBe("восемь ровно");
  });
});

describe("verbalizeCurrency", () => {
  it("рубли — основные кейсы", () => {
    // §21: 1500 произносится как полторы тысячи.
    expect(verbalizeCurrency("1500₽").trim()).toBe("полторы тысячи рублей");
    expect(speakRubles(1500)).toBe("полторы тысячи рублей");
    expect(verbalizeCurrency("100 руб").trim()).toBe("сто рублей");
    expect(verbalizeCurrency("1 руб").trim()).toBe("один рубль");
    // 2500 — разговорная полукруглая форма (§21): «две с половиной тысячи».
    expect(speakRubles(2500)).toBe("две с половиной тысячи рублей");
    // Некруглая сумма идёт по общему алгоритму.
    expect(speakRubles(2347)).toBe("две тысячи триста сорок семь рублей");
  });
  it("разделители тысяч", () => {
    expect(verbalizeCurrency("1 500₽").trim()).toBe("полторы тысячи рублей");
  });
});

describe("verbalizePhones", () => {
  it("по группам", () => {
    const out = verbalizePhones("+7 (495) 123-45-67").trim();
    expect(out).toContain("плюс семь");
    expect(out).toContain("четыре девять пять");
  });
});

describe("очистка markdown / кода", () => {
  it("убирает блоки кода", () => {
    expect(stripCodeBlocks("текст ```js\nconst x=1\n``` хвост").trim()).toBe("текст   хвост".trim());
    expect(stripCodeBlocks("инлайн `code` тут")).toBe("инлайн code тут");
  });
  it("снимает разметку", () => {
    expect(stripMarkdown("**жирно** и *курсив*")).toBe("жирно и курсив");
    expect(stripMarkdown("# Заголовок")).toBe("Заголовок");
    expect(stripMarkdown("[Гугл](https://google.com)")).toBe("Гугл");
    expect(stripMarkdown("- пункт")).toBe("пункт");
  });
});

describe("verbalize (полный конвейер)", () => {
  it("чистит и нормализует разом", () => {
    const out = verbalize("Встреча в **8:20**, бюджет 1500₽. Ссылка: https://x.io");
    expect(out).toContain("восемь двадцать");
    expect(out).toContain("полторы тысячи рублей");
    expect(out).not.toContain("**");
    expect(out).not.toContain("https://");
  });
});
