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
    expect(r.matched).toBe(true); // релевантный раздел реально нашёлся
    expect(r.text.toLowerCase()).toMatch(/риск/);
    expect(r.text).toMatch(/стоп|позици/i);
  });

  it("consult: запрос про RSI/дивергенцию → раздел индикаторов", () => {
    const r = kb.consult("trading", "дивергенция RSI перекупленность");
    expect(r.text).toMatch(/RSI|дивергенц/i);
  });

  it("consult: пустой запрос → ОБЗОР домена (intro, matched:true — не промах)", () => {
    const r = kb.consult("trading", "");
    expect(r.found).toBe(true);
    expect(r.matched).toBe(true); // запрос обзора — осознанный, intro легитимен
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.topics.length).toBeGreaterThan(4);
  });

  // Аудит контекста 2026-07-20: ЧЕСТНЫЙ промах — не выдаём intro за состоявшуюся консультацию.
  // (Запрос без токенов-подстрок трейдинг-терминов: «тема»⊂«сис-тема» ложно матчила бы substring-скорером.)
  it("consult: непопавший запрос → matched:false, ПУСТОЙ text, темы для уточнения", () => {
    const r = kb.consult("trading", "фотосинтез кенгуру балалайка");
    expect(r.found).toBe(true);     // домен есть
    expect(r.matched).toBe(false);  // но релевантного раздела нет — честно
    expect(r.text).toBe("");        // intro НЕ подсовывается как «консультация»
    expect(r.topics.length).toBeGreaterThan(0); // темы для уточнения
  });

  it("неизвестный домен → found:false (честно, не выдумывает)", () => {
    const r = kb.consult("медицина", "что-то");
    expect(r.found).toBe(false);
    expect(r.matched).toBe(false);
  });
});
