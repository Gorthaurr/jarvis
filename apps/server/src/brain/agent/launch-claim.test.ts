/**
 * W1-ревью р2 (loop-bypass-4): текстовая часть «заявки только о запуске» (loop/launch-claim.ts). Проводка — петлёй в
 * goal-check-verified-loop.test.ts; здесь границы самой эвристики «дело сверх запуска».
 */
import { describe, expect, it } from "vitest";
import { claimsDeedBeyondLaunch } from "./loop/launch-claim.js";

describe("claimsDeedBeyondLaunch — дело сверх запуска в финале", () => {
  it.each([
    "Открыл блокнот и напечатал «молоко», сэр.",
    "Запустил Доту и нажал «Играть», сэр.",
    "Открыл Telegram, нашёл чат Кати.",
    "Готово, ввёл адрес доставки.",
  ])("«%s» — заявлено дело", (text) => {
    expect(claimsDeedBeyondLaunch(text)).toBe(true);
  });

  it.each([
    "Дота запущена, сэр.",
    "Запустил Доту, сэр.",
    "Открыл терминал, сэр.", // объект сразу после «открыл» — не дело
    "Дота запустилась и загрузился лобби.", // возвратные — состояние программы, не дело Джарвиса
    "Открыл блокнот, текст «напечатал бы» в кавычках не в счёт.",
  ])("«%s» — только запуск", (text) => {
    expect(claimsDeedBeyondLaunch(text)).toBe(false);
  });
});
