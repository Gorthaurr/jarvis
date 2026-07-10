/**
 * Тесты identity-скраба (§11): навязанная шлюзом «Kiro» не должна звучать/отображаться.
 */
import { describe, expect, it } from "vitest";
import { scrubIdentity, stripAudioTags, stripToolCallSyntax, verbalize } from "./index.js";

describe("гигиена вывода: утёкший tool-call и аудио-теги (§21)", () => {
  it("вырезает сырой вызов инструмента из текста (не произносим разметку)", () => {
    const leaked = '<invoke name="telegram_send_voice"><parameter name="to">Избранное</parameter><parameter name="text">Привет</parameter></invoke>';
    expect(stripToolCallSyntax(leaked).trim()).toBe("");
    expect(verbalize(`Готово. ${leaked}`).toLowerCase()).not.toContain("invoke");
    expect(verbalize(`Готово. ${leaked}`).toLowerCase()).not.toContain("parameter");
  });

  it("снимает antml-неймспейс и одиночные/незакрытые теги вызова", () => {
    expect(stripToolCallSyntax('<invoke name="x">a</invoke>').trim()).toBe("");
    expect(stripToolCallSyntax('хвост <parameter name="to">').trim()).toBe("хвост");
  });

  it("снимает аудио/эмоция-теги [warmly], но не трогает кириллицу и числа", () => {
    expect(stripAudioTags("[warmly] Здравствуйте").trim()).toBe("Здравствуйте");
    expect(stripAudioTags("[whispering] тихо")).not.toContain("[");
    expect(stripAudioTags("счёт [1] и [что-то]")).toBe("счёт [1] и [что-то]");
  });

  it("verbalize чистит и тег эмоции, и tool-call вместе", () => {
    const out = verbalize('[warmly] Здравствуйте, Антон. <invoke name="x"><parameter name="y">z</parameter></invoke>');
    expect(out).toContain("Здравствуйте");
    expect(out.toLowerCase()).not.toContain("warmly");
    expect(out.toLowerCase()).not.toContain("invoke");
  });
});

describe("scrubIdentity (§11)", () => {
  it("подменяет латинское имя Kiro на Джарвис", () => {
    expect(scrubIdentity("Я Kiro, чем помочь?")).toBe("Я Джарвис, чем помочь?");
  });

  it("подменяет кириллическое Киро на Джарвис", () => {
    expect(scrubIdentity("Меня зовут Киро.")).toBe("Меня зовут Джарвис.");
  });

  it("ловит имя независимо от регистра", () => {
    expect(scrubIdentity("привет, я KIRO")).toBe("привет, я Джарвис");
  });

  it("снимает самоописание «AI-ассистент для разработки»", () => {
    const out = scrubIdentity("Я не Жарко — я Kiro, AI-ассистент для разработки.");
    expect(out).toContain("Джарвис");
    expect(out.toLowerCase()).not.toContain("для разработки");
  });

  it("снимает английское self-id", () => {
    const out = scrubIdentity("I'm Kiro, an AI assistant for software development.");
    expect(out).toContain("Джарвис");
    expect(out.toLowerCase()).not.toContain("assistant for software");
  });

  it("не трогает слова, в которых kiro лишь подстрока", () => {
    // граница слова: «кирпич»/«Kirov» не должны пострадать
    expect(scrubIdentity("кирпич и Kirov")).toBe("кирпич и Kirov");
  });

  it("verbalize() прогоняет скраб первым шагом", () => {
    expect(verbalize("Я Kiro.")).toContain("Джарвис");
    expect(verbalize("Я Kiro.").toLowerCase()).not.toContain("kiro");
  });
});
