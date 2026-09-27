/** W2: признаки секретов (перенос из credential-guard/order-guard) и разбор элемента в фокусе read.screen. */
import { describe, expect, it } from "vitest";
import { cardNumberIn, carriesCardNumber, looksLikeSecretField, parseFocusedLine, passesLuhn } from "./credential-risk.js";

describe("карта", () => {
  it("Луна: тестовая Visa проходит, соседняя цифра — нет; длина вне 13-19 — нет", () => {
    expect(passesLuhn("4111111111111111")).toBe(true);
    expect(passesLuhn("4111111111111112")).toBe(false);
    expect(passesLuhn("411111111111")).toBe(false);
  });

  it("cardNumberIn нормализует любые разделители; carriesCardNumber — только кандидата, не склейку слов", () => {
    expect(cardNumberIn("4111,1111,1111,1111")).toBe(true);
    expect(carriesCardNumber("карта 4111 1111 1111 1111 до 12/27")).toBe(true);
    expect(carriesCardNumber("4111-1111-1111-1111")).toBe(true);
    // Цифры разных слов через кириллицу не склеиваются в «номер».
    expect(carriesCardNumber("const timeout = 120000; // 2026 год, версия 1.2.3")).toBe(false);
    expect(carriesCardNumber("телефон 8 800 555 35 35")).toBe(false);
  });
});

describe("looksLikeSecretField", () => {
  it("пароль и одноразовый код — да; промокод, passport, голое code — нет", () => {
    for (const h of ["Пароль", "password", "Код из СМС", "one-time code", ["x", "пин-код"]]) expect(looksLikeSecretField(h as string), String(h)).toBe(true);
    for (const h of ["Промокод", "passport", "code", "Поиск"]) expect(looksLikeSecretField(h), h).toBe(false);
  });
});

describe("parseFocusedLine (реальная форма UiaGrounder.CollectText)", () => {
  it.each([
    ["ControlType.Edit: Пароль [ЗАЩИЩЕНО]\nControlType.Text: подсказка", { role: "Edit", name: "Пароль", secret: true }],
    ["ControlType.Button: Отправить", { role: "Button", name: "Отправить", secret: false }],
    ["ControlType.Edit: Поиск [ПУСТО]", { role: "Edit", name: "Поиск", secret: false }],
    ["ControlType.Edit: Имя [Катя [Москва]]", { role: "Edit", name: "Имя [Катя", secret: false }],
    ["\n  ControlType.Document: Без имени [текст]", { role: "Document", name: "Без имени", secret: false }],
    ["ControlType.Edit:  [ЗАЩИЩЕНО]", { role: "Edit", name: "", secret: true }],
  ])("%j", (text, want) => {
    expect(parseFocusedLine(text)).toEqual(want);
  });

  it("не строка роли → null", () => {
    expect(parseFocusedLine("")).toBeNull();
    expect(parseFocusedLine("просто текст без роли")).toBeNull();
  });
});
