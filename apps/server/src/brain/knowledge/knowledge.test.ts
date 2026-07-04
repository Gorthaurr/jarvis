import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "./index.js";

describe("KnowledgeBase — экспертное знание по доменам (§экспертность)", () => {
  const kb = new KnowledgeBase(); // грузит реальный docs/trading.md (тест против настоящего свода)

  it("домен trading и его темы загружены", () => {
    expect(kb.domains()).toContain("trading");
    expect(kb.topics("trading").length).toBeGreaterThan(4);
  });

  it("consult: запрос про риск → раздел управления риском", () => {
    const r = kb.consult("trading", "риск стоп размер позиции");
    expect(r.found).toBe(true);
    expect(r.text.toLowerCase()).toMatch(/риск/);
    expect(r.text).toMatch(/стоп|позици/i);
  });

  it("consult: запрос про RSI/дивергенцию → раздел индикаторов", () => {
    const r = kb.consult("trading", "дивергенция RSI перекупленность");
    expect(r.text).toMatch(/RSI|дивергенц/i);
  });

  it("consult: пустой запрос → вступление + оглавление", () => {
    const r = kb.consult("trading", "");
    expect(r.found).toBe(true);
    expect(r.topics.length).toBeGreaterThan(4);
  });

  it("consult: непопавший запрос → вступление (не пусто) + темы для уточнения", () => {
    const r = kb.consult("trading", "zzz несуществующая тема qqq");
    expect(r.found).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.topics.length).toBeGreaterThan(0);
  });

  it("неизвестный домен → found:false (честно, не выдумывает)", () => {
    expect(kb.consult("медицина", "что-то").found).toBe(false);
  });
});
