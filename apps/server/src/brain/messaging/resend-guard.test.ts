import { describe, expect, it } from "vitest";
import { ResendGuard, normalizeSendBody, peerIdentityKeys, similarSendBody } from "./resend-guard.js";

describe("normalizeSendBody — «то же ли это сообщение» (эпизод двойной отправки 2026-07-24)", () => {
  it("регистр/пунктуация/пробелы не делают другое сообщение", () => {
    expect(normalizeSendBody("Я люблю тебя.")).toBe(normalizeSendBody("я  люблю тебя"));
    expect(normalizeSendBody("Я люблю тебя!!!")).toBe(normalizeSendBody("я люблю тебя"));
    expect(normalizeSendBody("Ёлка")).toBe(normalizeSendBody("елка"));
  });

  it("текст целиком из эмодзи не схлопывается в пустоту (разные эмодзи ≠ один ключ)", () => {
    expect(normalizeSendBody("❤️")).not.toBe("");
    expect(normalizeSendBody("❤️")).not.toBe(normalizeSendBody("👍"));
  });
});

describe("similarSendBody — похожесть текстов", () => {
  const n = normalizeSendBody;
  it("прицеп эмодзи/частицы → похоже", () => {
    expect(similarSendBody(n("я люблю тебя"), n("люблю тебя ❤️"))).toBe(true);
  });
  it("разное содержание → НЕ похоже (легитимное «вдогонку»)", () => {
    expect(similarSendBody(n("приду в 8"), n("куплю хлеб по пути"))).toBe(false);
  });
  it("короткие односимвольные тексты без содержательного пересечения → НЕ похоже", () => {
    expect(similarSendBody(n("1"), n("2"))).toBe(false);
  });
});

describe("ResendGuard — окно «этому человеку только что уже уходило»", () => {
  it("identical: тот же нормализованный текст под любым ключом идентичности", () => {
    let t = 1_000;
    const g = new ResendGuard(120_000, () => t);
    g.record("u1", "telegram", ["peer:42", "name:катя"], "Я люблю тебя");
    t += 12_000; // как в живом эпизоде: 12 секунд между отправками
    // Другое написание имени («Кате»), но тот же peerId → тот же человек; текст с иной пунктуацией.
    const hit = g.check("u1", "telegram", ["peer:42", "name:кате"], "я люблю тебя.");
    expect(hit?.kind).toBe("identical");
    expect(hit?.ageMs).toBe(12_000);
  });

  it("similar: почти тот же текст → similar (нужен confirm)", () => {
    let t = 0;
    const g = new ResendGuard(120_000, () => t);
    g.record("u1", "telegram", ["name:катя"], "я люблю тебя");
    t = 30_000;
    expect(g.check("u1", "telegram", ["name:катя"], "люблю тебя ❤️")?.kind).toBe("similar");
  });

  it("другой текст тому же человеку → не хит (вторая отправка легитимна)", () => {
    const g = new ResendGuard(120_000, () => 0);
    g.record("u1", "telegram", ["name:катя"], "приду в 8");
    expect(g.check("u1", "telegram", ["name:катя"], "и куплю хлеб")).toBeUndefined();
  });

  it("окно истекло → не хит", () => {
    let t = 0;
    const g = new ResendGuard(120_000, () => t);
    g.record("u1", "telegram", ["name:катя"], "я люблю тебя");
    t = 121_000;
    expect(g.check("u1", "telegram", ["name:катя"], "я люблю тебя")).toBeUndefined();
  });

  it("другой пользователь/канал/адресат → не хит (изоляция ключей)", () => {
    const g = new ResendGuard(120_000, () => 0);
    g.record("u1", "telegram", ["name:катя"], "привет");
    expect(g.check("u2", "telegram", ["name:катя"], "привет")).toBeUndefined();
    expect(g.check("u1", "vk", ["name:катя"], "привет")).toBeUndefined();
    expect(g.check("u1", "telegram", ["name:маша"], "привет")).toBeUndefined();
  });

  it("окно 0 → гард выключен (check/record no-op)", () => {
    const g = new ResendGuard(0, () => 0);
    g.record("u1", "telegram", ["name:катя"], "привет");
    expect(g.check("u1", "telegram", ["name:катя"], "привет")).toBeUndefined();
  });

  it("склонение имени БЕЗ peerId («Катя»→«Кате») ловится стем-ключом", () => {
    const g = new ResendGuard(120_000, () => 0);
    g.record("u1", "telegram", peerIdentityKeys({ names: ["Катя"] }), "я люблю тебя");
    const hit = g.check("u1", "telegram", peerIdentityKeys({ names: ["Кате"] }), "я люблю тебя.");
    expect(hit?.kind).toBe("identical");
  });
});

describe("peerIdentityKeys — ключи идентичности адресата", () => {
  it("peerId + имя + стем; дубликаты схлопнуты", () => {
    const keys = peerIdentityKeys({ peerId: "42", names: ["Катя", "катя"] });
    expect(keys).toContain("peer:42");
    expect(keys).toContain("name:катя");
    expect(keys).toContain("stem:кат");
    expect(keys.filter((k) => k === "name:катя")).toHaveLength(1);
  });

  it("короткие имена (<4) стем не получают (слишком фуззи)", () => {
    expect(peerIdentityKeys({ names: ["Ия"] }).some((k) => k.startsWith("stem:"))).toBe(false);
  });

  it("пустые/undefined имена не дают ключей", () => {
    expect(peerIdentityKeys({ names: ["", undefined] })).toEqual([]);
  });
});
