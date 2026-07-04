/**
 * Тесты маршрутизатора тиров (§7).
 */
import { describe, expect, it } from "vitest";
import { classifyTier, matchLocalIntent, matchMediaIntent, resolveClarifyAnswer } from "./index.js";

describe("matchLocalIntent", () => {
  it("распознаёт запуск приложения", () => {
    expect(matchLocalIntent("открой Notion")).toEqual({ kind: "app.launch", app: "notion" });
    // Cyrillic-имя вне списка веб-сервисов → запуск приложения.
    expect(matchLocalIntent("запусти блокнот")).toEqual({ kind: "app.launch", app: "блокнот" });
    expect(matchLocalIntent("включи VS Code")).toEqual({ kind: "app.launch", app: "vs code" });
  });

  it("fuzzy-матчинг веб-сервиса при опечатке ≤1 (СТРОГО: общий префикс + расстояние 1)", () => {
    // distance 1 + общее начало → сервис распознан.
    expect(matchLocalIntent("открой тельграм")).toEqual({ kind: "browser.open", url: "https://web.telegram.org", inDefault: true });
    expect(matchLocalIntent("запусти ютубе")).toEqual({ kind: "browser.open", url: "https://youtube.com", inDefault: true });
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

  it("P1.2: фраза-инструкция (контент-сущ./предлог-связка) НЕ схлопывается в слепой app.launch → LLM", () => {
    // «джазовый плейлист» — это «поставь музыку», а не запуск exe с таким именем. Решает модель.
    expect(matchLocalIntent("включи джазовый плейлист")).toBeUndefined();
    expect(matchLocalIntent("запусти расслабляющую музыку")).toBeUndefined();
    // «X в поиске» — предлог-связка в многословии → инструкция, не голое имя.
    expect(matchLocalIntent("запусти доту в поиске")).toBeUndefined();
    // голое имя приложения по-прежнему ловится (регрессия не задета)
    expect(matchLocalIntent("запусти блокнот")).toEqual({ kind: "app.launch", app: "блокнот" });
    expect(matchLocalIntent("открой Spotify")).toEqual({ kind: "app.launch", app: "spotify" });
  });

  it("срезает слово-будильник и вежливость из транскрипта STT", () => {
    // STT включает «Джарвис, привет!» в текст — без среза LAUNCH_RE не сработал бы.
    expect(matchLocalIntent("Джарвис, привет! Запусти Инстаграм.")).toEqual({
      kind: "browser.open",
      url: "https://instagram.com",
      inDefault: true,
    });
    expect(matchLocalIntent("Сервис, открой блокнот")).toEqual({ kind: "app.launch", app: "блокнот" });
    expect(matchLocalIntent("открой блокнот пожалуйста")).toEqual({ kind: "app.launch", app: "блокнот" });
  });

  it("находит веб-сервис ВНУТРИ фразы и срезает хвост («в браузере», «ты это умеешь»)", () => {
    expect(matchLocalIntent("Джарвис, открой инстаграм в браузере")).toEqual({
      kind: "browser.open",
      url: "https://instagram.com",
      inDefault: true,
    });
    expect(matchLocalIntent("Открой Инстаграм, ты это умеешь")).toEqual({
      kind: "browser.open",
      url: "https://instagram.com",
      inDefault: true,
    });
    expect(matchLocalIntent("открой ютуб пожалуйста")).toEqual({ kind: "browser.open", url: "https://youtube.com", inDefault: true });
  });

  it("распознаёт открытие сайта/URL", () => {
    expect(matchLocalIntent("открой сайт example.com")).toEqual({
      kind: "browser.open",
      url: "https://example.com",
      inDefault: true,
    });
    // Известный веб-сервис (телеграм) → веб-версия, а не запуск exe (надёжнее на Windows).
    expect(matchLocalIntent("запусти телеграм")).toEqual({
      kind: "browser.open",
      url: "https://web.telegram.org",
      inDefault: true,
    });
    expect(matchLocalIntent("открой youtube.com")).toEqual({
      kind: "browser.open",
      url: "https://youtube.com",
      inDefault: true,
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

describe("resolveClarifyAnswer (стем на границе слова; неоднозначность → LLM)", () => {
  it("падежная форма матчит стем («волну»→opt «волн»)", () => {
    expect(resolveClarifyAnswer("yandexmusic", "волну")).toEqual({ kind: "browser.open", url: "https://music.yandex.ru", inDefault: true });
    expect(resolveClarifyAnswer("yandexmusic", "коллекцию")).toEqual({ kind: "browser.open", url: "https://music.yandex.ru/users", inDefault: true });
  });

  it("однозначный ответ youtube → действие", () => {
    expect(resolveClarifyAnswer("youtube", "рекомендации")).toMatchObject({ kind: "browser.open", url: "https://youtube.com" });
  });

  it("H8: поисковый ответ С запросом → URL ПОИСКА (а не голая главная с ложным «Открыл»)", () => {
    expect(resolveClarifyAnswer("youtube", "найди про котов")).toEqual({
      kind: "browser.open",
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent("котов")}`,
      inDefault: true,
    });
    expect(resolveClarifyAnswer("yandexmusic", "поищи кармэн")).toEqual({
      kind: "browser.open",
      url: `https://music.yandex.ru/search?text=${encodeURIComponent("кармэн")}`,
      inDefault: true,
    });
  });

  it("H8: поисковый ответ БЕЗ запроса → undefined (LLM доуточнит, НЕ открываем главную)", () => {
    expect(resolveClarifyAnswer("youtube", "найди")).toBeUndefined();
    expect(resolveClarifyAnswer("youtube", "конкретное видео")).toBeUndefined();
  });

  it("неоднозначный ответ (волну И поиск) → undefined (решает модель)", () => {
    // «найди мою волну» бьёт и opt1 (волн/мою), и opt3 (найд) → не угадываем
    expect(resolveClarifyAnswer("yandexmusic", "найди мою волну")).toBeUndefined();
  });

  it("стем НЕ ловится в середине слова без границы (нет ложного матча)", () => {
    // ответ-невпопад: ни один токен не начинается с триггер-стема
    expect(resolveClarifyAnswer("yandexmusic", "какая сегодня погода")).toBeUndefined();
  });

  it("пустой/неизвестный ключ → undefined", () => {
    expect(resolveClarifyAnswer("yandexmusic", "   ")).toBeUndefined();
    expect(resolveClarifyAnswer("unknown", "волну")).toBeUndefined();
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

  it("P1.1: чистое рассуждение/совет/разбор → fable (Opus), не слабый Sonnet", () => {
    expect(classifyTier("объясни почему небо голубое").tier).toBe("fable");
    expect(classifyTier("сравни два ноутбука и посоветуй").tier).toBe("fable");
    expect(classifyTier("как мне лучше поступить в этой ситуации").tier).toBe("fable");
    expect(classifyTier("проанализируй мой план на день").tier).toBe("fable");
    expect(classifyTier("стоит ли брать эту квартиру").tier).toBe("fable");
  });

  it("P1.1: многошаговое ДЕЙСТВИЕ без маркеров рассуждения → sonnet (не жжём Opus)", () => {
    expect(classifyTier("найди отчёт и положи на рабочий стол").tier).toBe("sonnet");
    expect(classifyTier("скачай картинку и сохрани в загрузки").tier).toBe("sonnet");
  });

  it("ВОПРОС → conversational (синхронный разговор, НЕ фоновая задача); фикс «каждый вопрос как задача»", () => {
    for (const q of [
      "какая столица Франции",
      "сколько будет два плюс два",
      "что такое блокчейн простыми словами",
      "кто написал войну и мир",
      "где находится Эльбрус",
      "расскажи про квантовую запутанность",
      "это вообще законно?",
      "законно ли парсить сайты",
      "можно ли это сделать без кода",
    ]) {
      const d = classifyTier(q);
      expect(d.conversational).toBe(true); // отвечается разговором, не задачей
    }
    // простой вопрос — на дешёвый тир (token-эконом); глубокое рассуждение — сильная модель, но ВСЁ РАВНО разговор
    expect(classifyTier("какая столица Франции").tier).toBe("haiku");
    expect(classifyTier("объясни почему небо голубое").conversational).toBe(true);
    expect(classifyTier("объясни почему небо голубое").tier).toBe("fable");
  });

  it("ДЕЙСТВИЕ → НЕ conversational (фоновая задача); вопросительное слово В СЕРЕДИНЕ не делает командой вопрос", () => {
    for (const a of ["сделай что-нибудь полезное", "отправь сообщение Пете", "создай файл на рабочем столе", "сделай мне отчёт по продажам"]) {
      const d = classifyTier(a);
      expect(d.conversational).not.toBe(true); // это действие-задача
      expect(d.tier).toBe("sonnet");
    }
  });

  it("рассуждение + ГЛАГОЛ-ДЕЙСТВИЕ («проанализируй и составь») → задача (фон), не разговор", () => {
    expect(classifyTier("проанализируй данные и составь отчёт").conversational).not.toBe(true);
    expect(classifyTier("проанализируй номер два и составь").conversational).not.toBe(true);
    // но чистое рассуждение без глагола-действия остаётся разговором
    expect(classifyTier("проанализируй мой план на день").conversational).toBe(true);
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

  it("биржа/торговля → fable (макс модель Opus, без тиров)", () => {
    expect(classifyTier("сделай теханализ сбербанка").tier).toBe("fable");
    expect(classifyTier("какие котировки фьючерса на доллар").tier).toBe("fable");
    expect(classifyTier("посмотри биткоин и спрогнозируй").tier).toBe("fable");
    expect(classifyTier("что по RSI и MACD").tier).toBe("fable");
    expect(classifyTier("что у меня в портфеле по акциям").tier).toBe("fable");
    expect(classifyTier("дай прогноз по эфириуму").tier).toBe("fable");
    // НЕ-биржевое не уводим в Opus ложно
    expect(classifyTier("какой прогноз погоды").tier).not.toBe("fable");
    expect(classifyTier("создай файл на рабочем столе").tier).not.toBe("fable");
  });

  it("команда-действие вне allowlist (синоним-глагол) → sonnet, НЕ haiku-болтовня", () => {
    // Корень бага: «стартани»/«врубай» не в COMPLEX_MARKERS и не tier0 → раньше падали в haiku-болтовню.
    expect(classifyTier("стартани поиск игры в доте").tier).toBe("sonnet");
    expect(classifyTier("врубай поиск").tier).toBe("sonnet");
    expect(classifyTier("подскажи по экрану в игре").tier).toBe("sonnet");
  });

  it("явный трёп/благодарность остаются в haiku", () => {
    expect(classifyTier("привет").tier).toBe("haiku");
    expect(classifyTier("спасибо").tier).toBe("haiku");
    expect(classifyTier("спокойной ночи").tier).toBe("haiku");
  });

  it("похвала/реакция без задачи → haiku (не task-ack «Уже занимаюсь»)", () => {
    // Корень флэт-болтовни: «красава»/«ты лучший» уходили в sonnet → задачный ack на похвалу.
    expect(classifyTier("красава").tier).toBe("haiku");
    expect(classifyTier("о, красавчик, ну ты могёшь!").tier).toBe("haiku");
    expect(classifyTier("ты лучший").tier).toBe("haiku");
    expect(classifyTier("ого, мощно").tier).toBe("haiku");
    // Но реальная команда-действие НЕ должна попасть под похвалу:
    expect(classifyTier("стартани поиск в доте").tier).toBe("sonnet");
  });
});

describe("медиа/громкость → tier0 (§ мгновенные клавиши, без LLM)", () => {
  it("распознаёт паузу/плей/след/пред", () => {
    expect(matchMediaIntent("пауза")).toEqual({ kind: "media", op: "pause" });
    expect(matchMediaIntent("поставь на паузу")).toEqual({ kind: "media", op: "pause" });
    expect(matchMediaIntent("стоп")).toEqual({ kind: "media", op: "pause" });
    expect(matchMediaIntent("продолжи")).toEqual({ kind: "media", op: "play" });
    expect(matchMediaIntent("следующий трек")).toEqual({ kind: "media", op: "next" });
    expect(matchMediaIntent("следующий")).toEqual({ kind: "media", op: "next" });
    expect(matchMediaIntent("предыдущий трек")).toEqual({ kind: "media", op: "prev" });
  });

  it("распознаёт громкость", () => {
    expect(matchMediaIntent("громче")).toEqual({ kind: "volume", op: "up" });
    expect(matchMediaIntent("потише")).toEqual({ kind: "volume", op: "down" });
    expect(matchMediaIntent("выключи звук")).toEqual({ kind: "volume", op: "mute" });
    expect(matchMediaIntent("громкость 30")).toEqual({ kind: "volume", op: "set", level: 30 });
    expect(matchMediaIntent("поставь громкость на 50%")).toEqual({ kind: "volume", op: "set", level: 50 });
    expect(matchMediaIntent("громкость 200")).toEqual({ kind: "volume", op: "set", level: 100 }); // кламп
  });

  it("медиа-команда классифицируется как tier0 (без LLM)", () => {
    expect(classifyTier("пауза").tier).toBe("tier0");
    expect(classifyTier("Джарвис, следующий трек").tier).toBe("tier0");
    expect(classifyTier("громче").tier).toBe("tier0");
  });

  it("НЕ ловит медиа в середине фразы (анти-ложное срабатывание)", () => {
    // ^…$ — команда = вся фраза. Болтовня со словом «дальше»/«стоп» не должна дёргать клавишу.
    expect(matchMediaIntent("расскажи дальше про это")).toBeUndefined();
    expect(matchMediaIntent("почему ты остановился на полуслове")).toBeUndefined();
    expect(matchMediaIntent("какая сейчас громкость и почему так тихо")).toBeUndefined();
    expect(matchMediaIntent("назад")).toBeUndefined(); // конфликт с browser-back — намеренно не берём
  });

  it("аудит 2026-07-02: живые фразы, гонявшие полный LLM, теперь tier0", () => {
    // «Videos, паузы сними.» — STT-шум перед запятой + инверсия «сними с паузы» = ВОЗОБНОВИ
    expect(matchMediaIntent("Videos, паузы сними")).toEqual({ kind: "media", op: "play" });
    expect(matchMediaIntent("сними с паузы")).toEqual({ kind: "media", op: "play" });
    expect(matchMediaIntent("убери паузу")).toEqual({ kind: "media", op: "play" });
    expect(matchMediaIntent("продолжи видео на ютубе")).toEqual({ kind: "media", op: "play" });
    expect(matchMediaIntent("продолжу видео на ютубе")).toEqual({ kind: "media", op: "play" }); // STT-вариация 1-го лица
    expect(matchMediaIntent("возобнови музыку")).toEqual({ kind: "media", op: "play" });
    expect(matchMediaIntent("останови музыку")).toEqual({ kind: "media", op: "pause" });
    expect(matchMediaIntent("выключи видео на ютубе")).toEqual({ kind: "media", op: "pause" });
    // M10: хвостовая вежливость не выбивает из tier0
    expect(matchMediaIntent("потише пожалуйста")).toEqual({ kind: "volume", op: "down" });
    expect(matchMediaIntent("пауза, пожалуйста")).toEqual({ kind: "media", op: "pause" });
    expect(matchMediaIntent("сделай погромче")).toEqual({ kind: "volume", op: "up" });
    // M5: кириллица после «следующ»/«включи следующ» (раньше \w — мёртвый паттерн)
    expect(matchMediaIntent("включи следующий")).toEqual({ kind: "media", op: "next" });
    expect(matchMediaIntent("переключи на следующую песню")).toEqual({ kind: "media", op: "next" });
    expect(matchMediaIntent("включи предыдущий трек")).toEqual({ kind: "media", op: "prev" });
  });

  it("аудит 2026-07-02: контент-задачи и болтовня НЕ ловятся новыми формами", () => {
    expect(matchMediaIntent("включи видео про котиков")).toBeUndefined(); // контент-поиск → LLM
    expect(matchMediaIntent("включи музыку")).toBeUndefined(); // «включи» ≠ resume: может быть «найди и включи»
    expect(matchMediaIntent("продолжи рассказ")).toBeUndefined(); // не медиа-объект
    expect(matchMediaIntent("выключи")).toBeUndefined(); // голое «выключи» — не медиа
    expect(matchMediaIntent("выключи компьютер")).toBeUndefined(); // питание, не пауза
    expect(matchMediaIntent("расскажи про паузы в музыке, это интересно и надолго")).toBeUndefined(); // длинный хвост после запятой
  });
});
