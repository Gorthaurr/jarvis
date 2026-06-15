/**
 * Тесты маршрутизатора тиров (§7).
 */
import { describe, expect, it } from "vitest";
import { classifyTier, matchLocalIntent } from "./index.js";

describe("matchLocalIntent", () => {
  it("распознаёт запуск приложения", () => {
    expect(matchLocalIntent("открой Notion")).toEqual({ kind: "app.launch", app: "notion" });
    // Cyrillic-имя вне списка веб-сервисов → запуск приложения.
    expect(matchLocalIntent("запусти блокнот")).toEqual({ kind: "app.launch", app: "блокнот" });
    expect(matchLocalIntent("включи VS Code")).toEqual({ kind: "app.launch", app: "vs code" });
  });

  it("fuzzy-матчинг веб-сервиса при опечатке ≤1 (СТРОГО: общий префикс + расстояние 1)", () => {
    // distance 1 + общее начало → сервис распознан.
    expect(matchLocalIntent("открой тельграм")).toEqual({ kind: "browser.open", url: "https://web.telegram.org" });
    expect(matchLocalIntent("запусти ютубе")).toEqual({ kind: "browser.open", url: "https://youtube.com" });
  });

  it("fuzzy НЕ ловит обычные слова как сервисы (точность > полноты)", () => {
    // «тикетов» НЕ должен открывать tiktok (а трактоваться как имя приложения); distance-2 — в LLM.
    expect(matchLocalIntent("открой тикетов")).toEqual({ kind: "app.launch", app: "тикетов" });
    expect(matchLocalIntent("запусти документ")).toEqual({ kind: "app.launch", app: "документ" });
    expect(matchLocalIntent("открой тельаграм")).toEqual({ kind: "app.launch", app: "тельаграм" });
  });

  it("не уводит фразу-вопрос в app.launch (жадный LAUNCH_RE)", () => {
    // «открой мне почему так дорого» — это вопрос, а не запуск «приложения».
    expect(matchLocalIntent("открой мне почему так дорого")).toBeUndefined();
    expect(matchLocalIntent("запусти уже наконец хоть что-нибудь полезное")).toBeUndefined();
  });

  it("срезает слово-будильник и вежливость из транскрипта STT", () => {
    // STT включает «Джарвис, привет!» в текст — без среза LAUNCH_RE не сработал бы.
    expect(matchLocalIntent("Джарвис, привет! Запусти Инстаграм.")).toEqual({
      kind: "browser.open",
      url: "https://instagram.com",
    });
    expect(matchLocalIntent("Сервис, открой блокнот")).toEqual({ kind: "app.launch", app: "блокнот" });
    expect(matchLocalIntent("открой блокнот пожалуйста")).toEqual({ kind: "app.launch", app: "блокнот" });
  });

  it("находит веб-сервис ВНУТРИ фразы и срезает хвост («в браузере», «ты это умеешь»)", () => {
    expect(matchLocalIntent("Джарвис, открой инстаграм в браузере")).toEqual({
      kind: "browser.open",
      url: "https://instagram.com",
    });
    expect(matchLocalIntent("Открой Инстаграм, ты это умеешь")).toEqual({
      kind: "browser.open",
      url: "https://instagram.com",
    });
    expect(matchLocalIntent("открой ютуб пожалуйста")).toEqual({ kind: "browser.open", url: "https://youtube.com" });
  });

  it("распознаёт открытие сайта/URL", () => {
    expect(matchLocalIntent("открой сайт example.com")).toEqual({
      kind: "browser.open",
      url: "https://example.com",
    });
    // Известный веб-сервис (телеграм) → веб-версия, а не запуск exe (надёжнее на Windows).
    expect(matchLocalIntent("запусти телеграм")).toEqual({
      kind: "browser.open",
      url: "https://web.telegram.org",
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

  it("задачи-действия (создай/запиши/настрой) → sonnet (для фоновой обработки §20)", () => {
    expect(classifyTier("создай файл на рабочем столе").tier).toBe("sonnet");
    expect(classifyTier("запиши число в таблицу").tier).toBe("sonnet");
    expect(classifyTier("настрой мне яркость").tier).toBe("sonnet");
  });

  it("пустой ввод → haiku без падения", () => {
    expect(classifyTier("   ").tier).toBe("haiku");
  });
});
