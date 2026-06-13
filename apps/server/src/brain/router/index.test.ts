/**
 * Тесты маршрутизатора тиров (§7).
 */
import { describe, expect, it } from "vitest";
import { classifyTier, matchLocalIntent } from "./index.js";

describe("matchLocalIntent", () => {
  it("распознаёт запуск приложения", () => {
    expect(matchLocalIntent("открой Notion")).toEqual({ kind: "app.launch", app: "notion" });
    expect(matchLocalIntent("запусти телеграм")).toEqual({ kind: "app.launch", app: "телеграм" });
    expect(matchLocalIntent("включи VS Code")).toEqual({ kind: "app.launch", app: "vs code" });
  });

  it("распознаёт открытие сайта/URL", () => {
    expect(matchLocalIntent("открой сайт example.com")).toEqual({
      kind: "browser.open",
      url: "https://example.com",
    });
    expect(matchLocalIntent("открой youtube.com")).toEqual({
      kind: "browser.open",
      url: "https://youtube.com",
    });
  });

  it("распознаёт фокус", () => {
    expect(matchLocalIntent("переключись на браузер")).toEqual({
      kind: "app.focus",
      app: "браузер",
    });
  });

  it("не реагирует на обычные фразы", () => {
    expect(matchLocalIntent("какая сегодня погода")).toBeUndefined();
    expect(matchLocalIntent("привет")).toBeUndefined();
  });
});

describe("classifyTier", () => {
  it("локальные паттерны → tier0", () => {
    const d = classifyTier("открой Spotify");
    expect(d.tier).toBe("tier0");
    expect(d.local).toEqual({ kind: "app.launch", app: "spotify" });
  });

  it("короткая болтовня → haiku", () => {
    expect(classifyTier("привет, как дела").tier).toBe("haiku");
  });

  it("многошаговая/рассуждающая → sonnet", () => {
    expect(classifyTier("найди отчёт и сравни с прошлым кварталом").tier).toBe("sonnet");
    expect(classifyTier("объясни почему небо голубое").tier).toBe("sonnet");
  });

  it("длинная формулировка → sonnet", () => {
    const long = "мне нужно ".repeat(20);
    expect(classifyTier(long).tier).toBe("sonnet");
  });

  it("пустой ввод → haiku без падения", () => {
    expect(classifyTier("   ").tier).toBe("haiku");
  });
});
