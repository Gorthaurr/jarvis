import { describe, expect, it } from "vitest";
import { type Contact, disambiguationPrompt, resolveContact } from "./contacts.js";

const masha1: Contact = { id: "1", displayName: "Мария Иванова", aliases: ["Маша", "маша иванова"], channels: { telegram: "@masha_i", vk: "id1" } };
const masha2: Contact = { id: "2", displayName: "Маша из зала", aliases: ["Маша"], channels: { telegram: "@gym_masha" } };
const petya: Contact = { id: "3", displayName: "Пётр", aliases: ["Петя"], channels: { vk: "id3" } };

describe("resolveContact (§13)", () => {
  it("однозначный алиас → match", () => {
    const r = resolveContact("Петя", [masha1, petya]);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.contact.id).toBe("3");
  });

  it("несколько «Маша» → ambiguous (голосовая дизамбигуация)", () => {
    const r = resolveContact("Маша", [masha1, masha2, petya]);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("точное полное имя имеет приоритет над частичным", () => {
    const r = resolveContact("Маша из зала", [masha1, masha2]);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.contact.id).toBe("2");
  });

  it("фильтр по каналу: нет адреса в канале → не кандидат", () => {
    const r = resolveContact("Маша", [masha1, masha2], "vk");
    expect(r.kind).toBe("match"); // только у masha1 есть vk
    if (r.kind === "match") expect(r.contact.id).toBe("1");
  });

  it("нет совпадений → none", () => {
    expect(resolveContact("Гендальф", [masha1]).kind).toBe("none");
  });

  it("фраза дизамбигуации перечисляет кандидатов", () => {
    const p = disambiguationPrompt("Маша", [masha1, masha2]);
    expect(p).toContain("Мария Иванова");
    expect(p).toContain("Маша из зала");
    expect(p).toContain("или");
  });
});
