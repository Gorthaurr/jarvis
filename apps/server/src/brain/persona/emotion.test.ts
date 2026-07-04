import { describe, expect, it } from "vitest";
import { emotionName, emotionOverlay, matchEmotionCommand } from "./emotion.js";

describe("matchEmotionCommand · распознаёт просьбу о подаче", () => {
  it("злость в разных формулировках → angry", () => {
    expect(matchEmotionCommand("говори зло")).toBe("angry");
    expect(matchEmotionCommand("скажи что-нибудь по-злому")).toBe("angry");
    expect(matchEmotionCommand("вырази злость")).toBe("angry");
    expect(matchEmotionCommand("Джарвис, скажи это сердито")).toBe("angry");
    expect(matchEmotionCommand("будь злым")).toBe("angry");
  });

  it("радость → happy", () => {
    expect(matchEmotionCommand("скажи радостно")).toBe("happy");
    expect(matchEmotionCommand("скажи с очень радостной интонацией")).toBe("happy");
    expect(matchEmotionCommand("говори весело")).toBe("happy");
    expect(matchEmotionCommand("ответь по-доброму")).toBe("happy");
  });

  it("строго / шёпотом", () => {
    expect(matchEmotionCommand("говори строго")).toBe("strict");
    expect(matchEmotionCommand("скажи шёпотом")).toBe("whisper");
    expect(matchEmotionCommand("произнеси шепотом")).toBe("whisper");
  });

  it("возврат к норме → neutral", () => {
    expect(matchEmotionCommand("говори обычно")).toBe("neutral");
    expect(matchEmotionCommand("говори нейтрально")).toBe("neutral");
    expect(matchEmotionCommand("скажи обычным тоном")).toBe("neutral");
  });

  it("НЕ перехватывает обычные реплики (нужен маркер о подаче речи)", () => {
    expect(matchEmotionCommand("открой ютуб")).toBeNull();
    expect(matchEmotionCommand("какой сегодня день")).toBeNull();
    expect(matchEmotionCommand("злой человек пришёл")).toBeNull(); // нет маркера речи
    expect(matchEmotionCommand("расскажи про злых собак")).toBeNull(); // «расскажи» ≠ маркер «скаж»
    expect(matchEmotionCommand("включи музыку погромче")).toBeNull();
  });
});

describe("emotionOverlay / emotionName", () => {
  it("оверлей для эмоции непустой и про подачу; neutral — пусто", () => {
    expect(emotionOverlay("angry")).toContain("зло");
    expect(emotionOverlay("happy").length).toBeGreaterThan(0);
    expect(emotionOverlay("neutral")).toBe("");
    expect(emotionOverlay(undefined)).toBe("");
    expect(emotionOverlay("ерунда")).toBe("");
  });
  it("оверлей злости явно разрешает актёрскую задачу (анти-отказ)", () => {
    expect(emotionOverlay("angry")).toMatch(/не отказывайся|актёрск/i);
  });
  it("человеко-имена", () => {
    expect(emotionName("angry")).toBe("зло");
    expect(emotionName("happy")).toBe("радостно");
  });
});
