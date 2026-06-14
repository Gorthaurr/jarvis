/**
 * Тесты identity-скраба (§11): навязанная шлюзом «Kiro» не должна звучать/отображаться.
 */
import { describe, expect, it } from "vitest";
import { scrubIdentity, verbalize } from "./index.js";

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
