/**
 * Якоря навыка (27.09, адверс-ревью р1): формы одной реплики STT («ЭИОС» / «эиос», «мини-тесты» / «мини тесты») e5-small
 * не различает на пороге 0.86 — якорь из ДАННЫХ навыка снимает порог детерминированно. Проводка: frontmatter
 * `anchors` → serializeLearnedSkill → хранилище → readLearned → RecalledSkill.anchors (иначе гейт их не увидит).
 * Реверт: убери `anchors` в readLearned (skills.ts) — падает проводка; `every` → `some` в anchorHit — падает «все основы».
 */
import { describe, expect, it } from "vitest";
import { anchorHit, parseAnchors } from "./skill-anchors.js";
import { createSkillProvider, parseSkillMd, seedSharedSkills, serializeLearnedSkill } from "./skills.js";

describe("якоря навыка", () => {
  it("совпадение без учёта регистра и ё; якорь из нескольких основ — нужны ВСЕ", () => {
    const a = parseAnchors("ЭИОС | учебн портал | мини тест");
    expect(a).toEqual(["эиос", "учебн портал", "мини тест"]);
    expect(anchorHit(a, "Пройди все Мини-Тесты во всех курсах.")).toBe(true);
    expect(anchorHit(a, "это мой Учебный Портал")).toBe(true);
    expect(anchorHit(a, "зайди на портал госуслуг")).toBe(false); // «портал» без «учебн»
    expect(anchorHit(a, "пройди тест на IQ")).toBe(false);
    expect(anchorHit(undefined, "эиос")).toBe(false);
  });

  it("мусор не становится якорем (пустое, короче 3 символов)", () => {
    expect(parseAnchors(" | a | ок ")).toEqual([]);
    expect(parseAnchors(42)).toEqual([]);
  });

  it("проводка: frontmatter → хранилище → recall отдаёт anchors навыку", async () => {
    const md = serializeLearnedSkill({ id: "learned__anchor-demo", name: "Демо якорей", version: 1, when: "когда нужен демо якорей", procedure: "шаг", anchors: ["Демоякорь", "два слова"] });
    expect(String(parseSkillMd(md).frontmatter.anchors)).toBe("демоякорь | два слова");
    await seedSharedSkills([md]);
    const r = await createSkillProvider().recall("u-anchor-reader", "когда нужен демо якорей");
    expect(r?.id).toBe("learned__anchor-demo");
    expect(r?.anchors).toEqual(["демоякорь", "два слова"]);
  });
});
