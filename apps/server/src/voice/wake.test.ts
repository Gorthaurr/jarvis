import { describe, it, expect } from "vitest";
import { isNoiseOnly, isWakeAddressed, stripWake } from "./wake.js";

describe("wake word «Джарвис»", () => {
  it("распознаёт обращение в разных формах и позициях", () => {
    expect(isWakeAddressed("Джарвис, который час")).toBe(true);
    expect(isWakeAddressed("открой блокнот, джарвис")).toBe(true);
    expect(isWakeAddressed("окей джарвес ты тут")).toBe(true);
    expect(isWakeAddressed("jarvis open notepad")).toBe(true);
  });

  it("НЕ срабатывает без обращения", () => {
    expect(isWakeAddressed("который сейчас час")).toBe(false);
    expect(isWakeAddressed("привет, как дела")).toBe(false);
  });

  it("не цепляет слово внутри другого", () => {
    expect(isWakeAddressed("джарвисовский протокол")).toBe(false);
  });

  it("ловит «г»-ослышки Deepgram (реальные пропуски из логов: «не откликался когда звал»)", () => {
    // Deepgram роняет «дж»→«г»: эти реплики были ПРОИГНОРИРОВАНЫ как «без обращения» — баг.
    expect(isWakeAddressed("Гарвис, ну мою волну вруби в Яндекс Музыке")).toBe(true);
    expect(isWakeAddressed("Гарвиз, руби рекомендации")).toBe(true);
    expect(isWakeAddressed("Jarry's, руби рекомендации просто")).toBe(true);
    // но обычные «г»-слова обращением не считаем (точность)
    expect(isWakeAddressed("где сейчас гарантия")).toBe(false);
    expect(isWakeAddressed("горизонт чистый")).toBe(false);
  });

  it("ловит латинские ослышки из живых логов (Jarious/Jarvias — fuzzy ≤2 не дотягивал)", () => {
    expect(isWakeAddressed("Jarious, ты отправил?")).toBe(true);
    expect(isWakeAddressed("Да, jarvias, отправляй.")).toBe(true);
    expect(isWakeAddressed("Джервис, отправь Кате голосовое")).toBe(true); // кириллица — уже была в списке
    expect(isWakeAddressed("Jarvi's ты отправил?")).toBe(true);
  });

  it("ловит лог-подтверждённые ослышки 2026-06-24 («Jares»/«Jarvey('s)»/«Jarvist» из server.out.log)", () => {
    expect(isWakeAddressed("Jares, напомни что через 15 минут")).toBe(true); // был МИСС (lev 3)
    expect(isWakeAddressed("Jarvey's, сними видео с паузы")).toBe(true);
    expect(isWakeAddressed("Jarvey Stalk, поставь паузу")).toBe(true);
    expect(isWakeAddressed("Ни хуя jarvist, ты мне пиздишь")).toBe(true);
    // без ложных срабатываний на обычных словах
    expect(isWakeAddressed("ярус облаков высокий")).toBe(false);
    expect(isWakeAddressed("январь холодный")).toBe(false);
  });

  it("вырезает обращение с прилегающей пунктуацией, оставляя команду", () => {
    expect(stripWake("Джарвис, открой блокнот")).toBe("открой блокнот");
    expect(stripWake("открой блокнот, джарвис")).toBe("открой блокнот");
    expect(stripWake("Джарвис")).toBe("");
  });
});

describe("шумовой фильтр (isNoiseOnly)", () => {
  it("считает шумом одиночные междометия", () => {
    expect(isNoiseOnly("ах")).toBe(true);
    expect(isNoiseOnly("ох.")).toBe(true);
    expect(isNoiseOnly("Хм")).toBe(true);
    expect(isNoiseOnly("ну э")).toBe(true);
    expect(isNoiseOnly("   ")).toBe(true);
    expect(isNoiseOnly("...")).toBe(true);
  });

  it("НЕ глушит валидные короткие ответы и команды", () => {
    expect(isNoiseOnly("да")).toBe(false);
    expect(isNoiseOnly("нет")).toBe(false);
    expect(isNoiseOnly("ага")).toBe(false);
    expect(isNoiseOnly("открой блокнот")).toBe(false);
    expect(isNoiseOnly("какой час")).toBe(false);
    expect(isNoiseOnly("ну давай")).toBe(false);
  });
});
