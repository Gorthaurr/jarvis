import { describe, expect, it } from "vitest";
import { humanizeProsody, verbalize, verbalizeLatinAcronyms } from "./index.js";

describe("humanizeProsody (§21 живая пунктуация)", () => {
  it("«...» → одно многоточие «…» (задумчивая пауза, не три рубленые точки)", () => {
    expect(humanizeProsody("Сейчас... подумаю")).toBe("Сейчас… подумаю");
  });

  it("дубли «!!!»/«??» схлопываются в один знак (эмфаза без крика)", () => {
    expect(humanizeProsody("Готово!!!")).toBe("Готово!");
    expect(humanizeProsody("Правда??")).toBe("Правда?");
  });

  it("дефис-тире « - »/« -- » → « — » (естественная пауза-вставка)", () => {
    expect(humanizeProsody("Бюджет - полторы тысячи")).toBe("Бюджет — полторы тысячи");
    expect(humanizeProsody("Сделал -- проверяю")).toBe("Сделал — проверяю");
  });

  it("ставит пробел после слипшейся запятой/многоточия", () => {
    expect(humanizeProsody("Да,конечно")).toBe("Да, конечно");
  });

  it("не калечит уже нормальный текст", () => {
    expect(humanizeProsody("Слышу вас, сэр.")).toBe("Слышу вас, сэр.");
  });
});

describe("verbalizeLatinAcronyms (§21 латиница → русская фонетика)", () => {
  it("ВЕРХНЕРЕГИСТРОВЫЕ аббревиатуры → по буквам по-русски", () => {
    expect(verbalizeLatinAcronyms("URL")).toBe("ю-ар-эль");
    expect(verbalizeLatinAcronyms("GPU")).toBe("джи-пи-ю");
    expect(verbalizeLatinAcronyms("AI")).toBe("эй-ай");
  });

  it("известные англицизмы/продукты → русское написание", () => {
    expect(verbalizeLatinAcronyms("Открыл YouTube")).toBe("Открыл ютуб");
    expect(verbalizeLatinAcronyms("в Telegram")).toBe("в телеграм");
  });

  it("кириллицу и смешанный регистр не трогает", () => {
    expect(verbalizeLatinAcronyms("Привет, как дела")).toBe("Привет, как дела");
    expect(verbalizeLatinAcronyms("OpenAI")).toBe("OpenAI");
  });
});

describe("verbalize: перенос строки → мягкий ритм, не жёсткая точка (фикс рваной речи)", () => {
  it("одиночный перенос внутри мысли → запятая-пауза, не точка", () => {
    expect(verbalize("Открыл почту\nпроверяю входящие")).toBe(
      "Открыл почту, проверяю входящие",
    );
  });

  it("если строка уже кончилась знаком — просто пробел (не плодим пунктуацию)", () => {
    expect(verbalize("Готово.\nЧто дальше?")).toBe("Готово. Что дальше?");
  });

  it("пустая строка (абзац) → конец мысли точкой", () => {
    expect(verbalize("Первое\n\nВторое")).toBe("Первое. Второе");
  });

  it("числа/латиница/ритм работают вместе сквозь весь конвейер", () => {
    expect(verbalize("Открыл YouTube, бюджет 1500 рублей...")).toBe(
      "Открыл ютуб, бюджет полторы тысячи рублей…",
    );
  });
});
