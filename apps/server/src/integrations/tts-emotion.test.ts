import { describe, expect, it } from "vitest";
import {
  type Emotion,
  EMOTIONS,
  elevenStabilityFor,
  elevenV3Tag,
  isEmotion,
  resolveYandexRole,
  yandexEmotionParam,
  yandexEmotionsForVoice,
} from "./tts-emotion.js";

describe("tts-emotion · resolveYandexRole (каталог проверен эмпирически)", () => {
  it("jane умеет полный набор good/evil/neutral", () => {
    expect(resolveYandexRole("jane", "happy")).toBe("good");
    expect(resolveYandexRole("jane", "angry")).toBe("evil");
    expect(resolveYandexRole("jane", "neutral")).toBe("neutral");
  });

  it("filipp (мужской) — happy НЕ умеет, angry деградирует до strict", () => {
    expect(resolveYandexRole("filipp", "happy")).toBeUndefined();
    expect(resolveYandexRole("filipp", "angry")).toBe("strict"); // нет evil → ближайшее строгое
    expect(resolveYandexRole("filipp", "strict")).toBe("strict");
  });

  it("ermil/zahar — happy=good, но evil/strict не умеют (undefined, без 400)", () => {
    expect(resolveYandexRole("ermil", "happy")).toBe("good");
    expect(resolveYandexRole("ermil", "angry")).toBeUndefined();
    expect(resolveYandexRole("zahar", "happy")).toBe("good");
  });

  it("незнакомый голос → undefined (не рискуем неизвестной ролью → 400)", () => {
    expect(resolveYandexRole("неизвестный", "happy")).toBeUndefined();
    expect(resolveYandexRole("неизвестный", "neutral")).toBeUndefined();
  });
});

describe("tts-emotion · yandexEmotionParam (400-безопасный итог)", () => {
  it("явная эмоция в приоритете над env", () => {
    expect(yandexEmotionParam("jane", "angry", "good")).toBe("evil");
  });

  it("эмоция, которую голос не умеет → не шлём (undefined, нейтрально)", () => {
    expect(yandexEmotionParam("filipp", "happy", "good")).toBeUndefined();
  });

  it("без явной эмоции — env, но только если голос поддерживает", () => {
    expect(yandexEmotionParam("jane", undefined, "good")).toBe("good");
    // filipp НЕ поддерживает 'good' → не шлём (раньше слали впустую; теперь чисто, без 400)
    expect(yandexEmotionParam("filipp", undefined, "good")).toBeUndefined();
    // omazh поддерживает evil, но не good → good не шлём (иначе HTTP 400 Unknown role)
    expect(yandexEmotionParam("omazh", undefined, "good")).toBeUndefined();
    expect(yandexEmotionParam("omazh", undefined, "evil")).toBe("evil");
  });

  it("пустой env → undefined", () => {
    expect(yandexEmotionParam("jane", undefined, "")).toBeUndefined();
    expect(yandexEmotionParam("jane", undefined, undefined)).toBeUndefined();
  });
});

describe("tts-emotion · доступные эмоции голоса", () => {
  it("jane — happy и angry доступны; filipp — angry(→strict) есть, happy нет", () => {
    expect(yandexEmotionsForVoice("jane")).toEqual(expect.arrayContaining(["happy", "angry", "neutral"]));
    const filipp = yandexEmotionsForVoice("filipp");
    expect(filipp).toContain("angry");
    expect(filipp).toContain("strict");
    expect(filipp).not.toContain("happy");
  });
});

describe("tts-emotion · ElevenLabs маппинг", () => {
  it("v3-тег по эмоции; neutral — без тега", () => {
    expect(elevenV3Tag("angry")).toBe("[angry]");
    expect(elevenV3Tag("happy")).toBe("[happily]");
    expect(elevenV3Tag("neutral")).toBe("");
  });
  it("эмоция снижает stability (шире просодия); neutral не трогает", () => {
    expect(elevenStabilityFor("neutral", 0.5)).toBe(0.5);
    expect(elevenStabilityFor("angry", 0.5)).toBeLessThanOrEqual(0.35);
    expect(elevenStabilityFor("happy", 0.2)).toBe(0.2); // уже ниже порога — не повышаем
  });
});

describe("tts-emotion · isEmotion / EMOTIONS", () => {
  it("узнаёт валидные и отвергает мусор", () => {
    for (const e of EMOTIONS) expect(isEmotion(e)).toBe(true);
    expect(isEmotion("веселье")).toBe(false);
    expect(isEmotion(undefined)).toBe(false);
  });
  it("EMOTIONS покрывает тип Emotion", () => {
    const all: Emotion[] = ["neutral", "happy", "angry", "strict", "whisper"];
    expect(new Set(EMOTIONS)).toEqual(new Set(all));
  });
});
