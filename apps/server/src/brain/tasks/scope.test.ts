import { describe, expect, it } from "vitest";
import { classifyTaskScope, isDuplicateGoal } from "./scope.js";

describe("classifyTaskScope — правка текущей vs новая задача (§20)", () => {
  it("явные маркеры правки → edit", () => {
    expect(classifyTaskScope("добавь раздел про флот")).toBe("edit");
    expect(classifyTaskScope("сделай подробнее")).toBe("edit");
    expect(classifyTaskScope("исправь дату во введении")).toBe("edit");
    expect(classifyTaskScope("допиши заключение")).toBe("edit");
    expect(classifyTaskScope("сократи это")).toBe("edit"); // «сократи» как стем
  });

  it("ссылки на текущий объект → edit", () => {
    expect(classifyTaskScope("добавь туда таблицу")).toBe("edit");
    expect(classifyTaskScope("в этот документ ещё график")).toBe("edit");
  });

  it("самостоятельное новое дело → new", () => {
    expect(classifyTaskScope("а ещё закажи такси")).toBe("new");
    expect(classifyTaskScope("открой почту")).toBe("new");
    expect(classifyTaskScope("посчитай смету на ремонт")).toBe("new");
    expect(classifyTaskScope("найди рейсы в Сочи")).toBe("new");
  });

  it("по умолчанию (без маркеров правки) → new — чтобы отдельная задача запускалась", () => {
    expect(classifyTaskScope("сделай презентацию по проекту")).toBe("new");
    expect(classifyTaskScope("")).toBe("new");
  });

  it("маркеры ОТКАЗА/редиректа («не то / не так / вместо») → edit (рулёжка текущей задачи)", () => {
    expect(classifyTaskScope("нет, не то")).toBe("edit");
    expect(classifyTaskScope("нет блин не то")).toBe("edit");
    expect(classifyTaskScope("ты делаешь не так")).toBe("edit");
    expect(classifyTaskScope("вместо этого открой сайт")).toBe("edit");
    expect(classifyTaskScope("сделай по другому")).toBe("edit");
    // бареное «лучше/иначе» НЕ должно ложно ловиться как правка (частотны вне рулёжки)
    expect(classifyTaskScope("лучше закажи такси")).toBe("new");
  });
});

describe("isDuplicateGoal — дубль-гейт активной задачи (§20, аудит 2026-07-02)", () => {
  it("живой случай: «продолжи/продолжу видео на ютубе» — дубль (STT-вариация словоформы)", () => {
    expect(isDuplicateGoal("продолжу видео на ютубе.", "продолжи видео на ютубе.")).toBe(true);
    expect(isDuplicateGoal("запусти поиск в доте", "запусти поиск в доте.")).toBe(true); // дословный повтор
  });

  it("разные дела при общих словах — НЕ дубль", () => {
    expect(isDuplicateGoal("прими матч в доте", "запусти поиск в доте")).toBe(false);
    expect(isDuplicateGoal("открой почту", "открой ютуб")).toBe(false);
    expect(isDuplicateGoal("закажи такси", "напиши реферат про такси")).toBe(false);
  });

  it("однословные фразы — не рискуем (не дубль)", () => {
    expect(isDuplicateGoal("ютуб", "открой ютуб")).toBe(false);
    expect(isDuplicateGoal("", "открой ютуб")).toBe(false);
  });
});
