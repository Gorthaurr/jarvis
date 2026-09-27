/** W2: класс клавиши — allowlist (закон «денилисты неполны»). Каждая строка ломается, если класс взять денилистом. */
import { describe, expect, it } from "vitest";
import { canonicalCombo, isBlockedCombo, keyClass, normalizeCombo } from "./commit-keys.js";

describe("keyClass", () => {
  it.each([
    ["a", "safe"],
    ["Shift+A", "safe"],
    ["7", "safe"],
    ["Backspace", "safe"],
    ["Delete", "safe"],
    ["ArrowDown", "safe"],
    ["Shift+ArrowLeft", "safe"],
    ["Ctrl+ArrowRight", "safe"],
    ["Home", "safe"],
    ["PageDown", "safe"],
    ["Tab", "safe"],
    ["Shift+Tab", "safe"],
    ["Esc", "safe"],
    ["Ctrl+A", "safe"],
    ["Ctrl+C", "safe"],
    ["ctrl+x", "safe"],
    ["Ctrl+Z", "safe"],
    ["Enter", "focusPress"],
    ["Space", "focusPress"],
    // Коммиты, которых денилист «есть Enter» не видел.
    ["Alt+S", "commit"],
    ["Ctrl+Shift+Z", "commit"],
    ["Ctrl+Y", "commit"],
    ["Ctrl+S", "commit"],
    ["F5", "commit"],
    ["Win+E", "commit"],
    ["Ctrl+Enter", "commit"],
    ["Shift+Enter", "commit"],
    ["Ctrl+Space", "commit"],
    ["a+Enter", "commit"],
    ["Insert", "commit"],
    // Отдельные классы.
    ["Alt+F4", "blocked"],
    ["Win+V", "blocked"],
    ["Meta+V", "blocked"],
    ["Ctrl+Alt+A", "autotype"],
    ["Ctrl+Shift+L", "autotype"],
    ["Ctrl+\\", "autotype"],
    ["Ctrl+V", "paste"],
    ["Shift+Insert", "paste"],
    ["Ctrl+Shift+V", "paste"],
  ])("%s → %s", (combo, cls) => {
    expect(keyClass(combo)).toBe(cls);
  });
});

describe("normalizeCombo / блок-лист (переезд из client/input.ts без изменения поведения)", () => {
  it("порядок, регистр, алиасы и дубль модификатора не обходят блок-лист", () => {
    expect(normalizeCombo(" Shift + Ctrl + s ")).toBe("ctrl+s+shift");
    expect(normalizeCombo("Control+Del")).toBe("ctrl+delete");
    for (const c of ["alt+f4", "F4+Alt", "Alt+Alt+F4", "LWin+L", "super+r", "Ctrl+Alt+Del", "Win+V"]) expect(isBlockedCombo(c), c).toBe(true);
    expect(isBlockedCombo("Alt+F5")).toBe(false);
  });

  it("canonicalCombo: «Ctrl+Enter» ≡ «enter+ctrl» ≡ «Control+Return»", () => {
    expect(canonicalCombo("Ctrl+Enter")).toBe("ctrl+enter");
    expect(canonicalCombo("enter+ctrl")).toBe("ctrl+enter");
    expect(canonicalCombo("Control+Return")).toBe("ctrl+enter");
    expect(canonicalCombo("Shift+Alt+S")).toBe("alt+shift+s");
  });
});
