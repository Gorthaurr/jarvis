/**
 * Рефлекс обязательств (волна D): «завтра надо позвонить маме» сам становится напоминанием.
 * Ключевое здесь — ПРЕФИЛЬТР: он решает, звать ли LLM. Слишком широкий = деньги и ложные будильники
 * на каждой реплике; слишком узкий = фича мертва. Плюс честность: команда Джарвису рефлексом не
 * перехватывается (её и так выполнит обычная петля).
 */
import { describe, expect, it } from "vitest";
import { hasCommitmentMarker } from "./commitment-reflect.js";

describe("hasCommitmentMarker — префильтр обязательств", () => {
  it("ловит дело владельца СО СРОКОМ", () => {
    expect(hasCommitmentMarker("завтра надо позвонить маме")).toBe(true);
    expect(hasCommitmentMarker("мне нужно в пятницу оплатить кредит")).toBe(true);
    expect(hasCommitmentMarker("не забыть вечером забрать посылку")).toBe(true);
    expect(hasCommitmentMarker("я должен сегодня сдать отчёт")).toBe(true);
    expect(hasCommitmentMarker("планирую завтра съездить на дачу")).toBe(true);
  });

  it("НЕ ловит дело БЕЗ срока (это намерение вообще, а не дело с датой)", () => {
    expect(hasCommitmentMarker("надо больше спать")).toBe(false);
    expect(hasCommitmentMarker("мне нужно похудеть")).toBe(false);
    expect(hasCommitmentMarker("я должен быть внимательнее")).toBe(false);
  });

  it("НЕ перехватывает КОМАНДЫ Джарвису — их выполняет обычная петля", () => {
    expect(hasCommitmentMarker("напомни завтра позвонить маме")).toBe(false);
    expect(hasCommitmentMarker("надо напомнить мне завтра про врача")).toBe(false);
    expect(hasCommitmentMarker("открой ютуб")).toBe(false);
    expect(hasCommitmentMarker("поставь будильник на 7")).toBe(false);
  });

  it("НЕ срабатывает на болтовне, вопросах и STT-шуме", () => {
    expect(hasCommitmentMarker("завтра будет дождь?")).toBe(false);
    expect(hasCommitmentMarker("вчера ходил в зал")).toBe(false);
    expect(hasCommitmentMarker("ага")).toBe(false);
    expect(hasCommitmentMarker("")).toBe(false);
  });

  it("время в разных формах засчитывается как срок", () => {
    expect(hasCommitmentMarker("надо в 18:30 забрать ребёнка")).toBe(true);
    expect(hasCommitmentMarker("нужно 5 августа продлить страховку")).toBe(true);
    expect(hasCommitmentMarker("надо через неделю сходить к врачу")).toBe(true);
  });
});
