/**
 * Гард опасных комбо (§6 «не навреди»): после инцидента «закрой Доту → Джарвис закрыл сам себя»
 * (Alt+F4 в эмуляции ввода) опасные глобальные комбо НЕ шлются. Нормализация регистра/порядка/алиасов.
 */
import { describe, expect, it } from "vitest";
import { isBlockedCombo, normalizeCombo } from "./input.js";

describe("input: гард опасных комбо (§6)", () => {
  it("Alt+F4 заблокирован в любом регистре/порядке/алиасе", () => {
    expect(isBlockedCombo("Alt+F4")).toBe(true);
    expect(isBlockedCombo("alt+f4")).toBe(true);
    expect(isBlockedCombo("F4+Alt")).toBe(true);
    expect(isBlockedCombo(" ALT + F4 ")).toBe(true);
  });

  it("системные/блокирующие комбо заблокированы (Win+L/R/D/M, Ctrl+Alt+Del, Win+Tab)", () => {
    for (const c of ["Win+L", "Win+R", "Win+D", "Win+M", "Win+Tab", "Ctrl+Alt+Delete", "Ctrl+Alt+Del", "Meta+L", "Super+R"]) {
      expect(isBlockedCombo(c)).toBe(true);
    }
  });

  it("обычные рабочие комбо РАЗРЕШЕНЫ (печать/навигация/игры)", () => {
    for (const c of ["Ctrl+S", "Ctrl+C", "Ctrl+V", "ArrowRight", "Space", "W", "Enter", "Tab", "Ctrl+Shift+T", "F5"]) {
      expect(isBlockedCombo(c)).toBe(false);
    }
  });

  it("normalizeCombo: алиасы win/del/control, регистр и порядок", () => {
    expect(normalizeCombo("Meta+L")).toBe(normalizeCombo("Win+L"));
    expect(normalizeCombo("Ctrl+Alt+Del")).toBe(normalizeCombo("Control+Alt+Delete"));
    expect(normalizeCombo("F4+Alt")).toBe(normalizeCombo("Alt+F4"));
  });
});
