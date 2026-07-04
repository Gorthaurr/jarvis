/**
 * Гард полярности намерения (§8, живой случай 2026-07-03): «прекрати поиск у доти» не должен
 * получать recall навыка «запустить поиск игры в дота 2» (с авто-макросом реплей ЗАПУСТИЛ бы
 * поиск вместо остановки). Строгий конфликт start↔stop, неоднозначность — модели.
 */
import { describe, expect, it } from "vitest";
import { intentPolarity, polarityConflict } from "./intent-polarity.js";

describe("intentPolarity (§8)", () => {
  it("стоп-глаголы → stop (словоформы, кириллица)", () => {
    expect(intentPolarity("прекрати поиск у доти")).toBe("stop");
    expect(intentPolarity("останови музыку")).toBe("stop");
    expect(intentPolarity("отмени очередь")).toBe("stop");
    expect(intentPolarity("выключи видео")).toBe("stop");
    expect(intentPolarity("стоп")).toBe("stop");
    expect(intentPolarity("stop the search")).toBe("stop");
  });

  it("запускные глаголы → start (словоформы, латиница)", () => {
    expect(intentPolarity("запусти поиск в доте")).toBe("start");
    expect(intentPolarity("включи свет")).toBe("start");
    expect(intentPolarity("найди катку в доту 2")).toBe("start");
    expect(intentPolarity("открой ютуб")).toBe("start");
    expect(intentPolarity("play some jazz")).toBe("start");
  });

  it("оба класса → mixed («поставь на паузу» не считается чистым start)", () => {
    expect(intentPolarity("поставь на паузу")).toBe("mixed");
    expect(intentPolarity("останови это и запусти заново")).toBe("mixed");
  });

  it("нет глаголов действия → neutral («перезапусти» намеренно не start)", () => {
    expect(intentPolarity("какая погода завтра")).toBe("neutral");
    expect(intentPolarity("перезапусти сервер")).toBe("neutral");
    expect(intentPolarity("")).toBe("neutral");
  });

  it("существительные не дают полярности («запуск» в описании — не глагол «запусти»)", () => {
    // Стем «запуст» ловит и «запуск» — это осознанно: триггер навыка «запуск поиска» ДОЛЖЕН
    // классифицироваться как start. Проверяем, что мусорные слова полярности не дают.
    expect(intentPolarity("выглядите отлично сэр")).toBe("neutral");
    expect(intentPolarity("больше всего в жизни")).toBe("neutral");
  });
});

describe("polarityConflict (§8)", () => {
  const START_SKILL = "Запустить поиск игры в Dota 2 когда прошу запустить поиск матча в доте";
  const STOP_SKILL = "Выключить музыку когда прошу вырубить звук";

  it("стоп-команда ↔ запускной навык → конфликт (живой случай)", () => {
    expect(polarityConflict("прекрати поиск у доти", START_SKILL)).toBe(true);
    expect(polarityConflict("останови поиск игры в дота 2", START_SKILL)).toBe(true);
  });

  it("запускная команда ↔ стоп-навык → конфликт (симметрия)", () => {
    expect(polarityConflict("включи музыку", STOP_SKILL)).toBe(true);
  });

  it("совпадающая полярность → НЕ конфликт", () => {
    expect(polarityConflict("запусти поиск доти", START_SKILL)).toBe(false);
    expect(polarityConflict("выключи музыку", STOP_SKILL)).toBe(false);
  });

  it("mixed/neutral с любой стороны → НЕ конфликт (неоднозначность — модели)", () => {
    expect(polarityConflict("останови это и запусти заново", START_SKILL)).toBe(false);
    expect(polarityConflict("что там с потоком", START_SKILL)).toBe(false);
    expect(polarityConflict("прекрати поиск", "Отчёт в Telegram прислать отчёт")).toBe(false);
  });
});
