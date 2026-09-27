/**
 * W2 П2 (§0): чистые признаки — эффект клавиши на набранное и поле-секрет по элементу UIA (реальные формы ролей:
 * снапшот «edit», ground «ControlType.Edit», read.screen «Edit»).
 * Реверт: Shift+цифра как цифра → «Shift+4»; подсказка у кнопок → «Показать пароль»; маска не читается → «•••».
 */
import { describe, expect, it } from "vitest";
import { isSecretElement, keyEffect } from "./secret-signs.js";

describe("keyEffect — что клавиша делает с набранным в поле", () => {
  it.each([
    ["7", { kind: "char", ch: "7" }],
    ["Space", { kind: "char", ch: " " }],
    ["Shift+4", { kind: "char", ch: "#" }], // «$» раскладки — не цифра: Луну не кормит
    ["Shift+a", { kind: "char", ch: "A" }],
    ["Backspace", { kind: "backspace" }],
    ["End", { kind: "keep" }],
    ["Shift+ArrowLeft", { kind: "keep" }],
    ["Ctrl+A", { kind: "keep" }],
    ["shift", { kind: "keep" }],
    ["ctrl", { kind: "keep" }],
    ["Enter", { kind: "reset" }],
    ["Tab", { kind: "reset" }],
    ["Escape", { kind: "reset" }],
    ["alt", { kind: "reset" }],
    ["Alt+S", { kind: "reset" }],
    ["F5", { kind: "reset" }],
    ["Ctrl+Backspace", { kind: "reset" }],
    ["Shift+Insert", { kind: "paste" }],
    ["alt+ctrl+a", { kind: "autotype" }],
  ])("%s → %o", (combo, effect) => {
    expect(keyEffect(combo)).toEqual(effect);
  });
});

describe("isSecretElement", () => {
  it("маска сайдкара «•••» — секрет при любом имени; подсказка — только у поля ввода", () => {
    expect(isSecretElement({ role: "edit", name: "", value: "•••" })).toBe(true);
    expect(isSecretElement({ role: "ControlType.Edit", name: "Пароль" })).toBe(true);
    expect(isSecretElement({ role: "edit", name: "", automationId: "PasswordBox" })).toBe(true);
    expect(isSecretElement({ role: "Edit", name: "Код подтверждения" })).toBe(true);
    expect(isSecretElement({ role: "", name: "Пин-код" })).toBe(true); // роль неизвестна — судим как поле
    expect(isSecretElement({ role: "button", name: "Показать пароль" })).toBe(false);
    expect(isSecretElement({ role: "hyperlink", name: "Забыли пароль?" })).toBe(false);
    expect(isSecretElement({ role: "edit", name: "Паспорт", value: "4510" })).toBe(false);
  });
});
