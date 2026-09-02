import { describe, expect, it } from "vitest";
import type { UsageInfo } from "@jarvis/protocol";
import { balanceLabel, money, planLabel, warnLabel } from "./billing-panel.js";

// Чистые label-функции — без DOM (jsdom в клиенте нет; initBillingPanel живьём — за владельцем).
const base: UsageInfo = { plan: "Базовый", period: "2026-09", spent: 1.234, cap: 20, remaining: 18.766, killSwitch: false };

describe("billing-panel — честная валюта и продуктовые поля", () => {
  it("dev-режим: суммы в $ (SpendGuard считает в USD), никакого «₽»", () => {
    const s = balanceLabel(base);
    expect(s).toBe("$1.23 из $20.00 · остаток $18.77 · 2026-09");
    expect(s).not.toContain("₽");
    expect(balanceLabel({ ...base, currency: "USD" })).toBe(s); // явная USD = то же
    expect(money(2, "EUR")).toBe("2.00 EUR"); // иная валюта — код валюты, а не подмена символа
  });

  it("кредиты плана: использовано/квота/остаток, процент — от факта, а не из pct", () => {
    const u: UsageInfo = { ...base, credits: { quota: 200, used: 50, remaining: 150, pct: 75 } };
    expect(balanceLabel(u)).toBe("кредиты: использовано 50 из 200 (остаток 150, 25% использовано) · 2026-09");
    // quota=0 — процент из pct (фолбэк), деления на ноль нет.
    expect(balanceLabel({ ...base, credits: { quota: 0, used: 0, remaining: 0, pct: 0 } })).toContain("0% использовано");
  });

  it("план: planName главнее метки, статус по-русски со сроком, стоп — как раньше", () => {
    expect(planLabel(base)).toBe("Базовый");
    expect(planLabel({ ...base, killSwitch: true })).toBe("Базовый (стоп)");
    expect(planLabel({ ...base, planName: "Pro", status: "trialing", periodEnd: "2026-10-12T00:00:00Z" })).toMatch(/^Pro · пробный до \d{2}\.\d{2}\.\d{4}$/);
    expect(planLabel({ ...base, status: "past_due" })).toBe("Базовый · ждёт оплаты");
    expect(planLabel({ ...base, status: "expired" })).toBe("Базовый · истёк");
    expect(planLabel({ ...base, status: "active" })).toBe("Базовый"); // «активен» не выдумываем
    expect(planLabel({ ...base, status: "trialing", periodEnd: "не дата" })).toBe("Базовый · пробный"); // без Invalid Date
  });

  it("порог warn: 80/100 → пометка, иначе пусто", () => {
    expect(warnLabel(base)).toBe("");
    expect(warnLabel({ ...base, warn: null })).toBe("");
    expect(warnLabel({ ...base, warn: "80" })).toContain("80%");
    expect(warnLabel({ ...base, warn: "100" })).toContain("исчерпан");
  });
});
