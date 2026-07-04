import { describe, expect, it } from "vitest";
import { isV3Model, sanitizeV3Tags, stripAudioTags } from "./voice-providers.js";

describe("аудио-теги интонации v3 (§21)", () => {
  describe("stripAudioTags — для дисплея и моделей кроме v3", () => {
    it("вырезает тег и не оставляет двойных пробелов", () => {
      expect(stripAudioTags("[warmly] Рад видеть вас, сэр.")).toBe("Рад видеть вас, сэр.");
    });
    it("вырезает тег в середине, знак примыкает к слову", () => {
      expect(stripAudioTags("Готово [softly] , сэр")).toBe("Готово, сэр");
    });
    it("текст без тегов не трогает", () => {
      expect(stripAudioTags("Слышу вас отлично.")).toBe("Слышу вас отлично.");
    });
  });

  describe("sanitizeV3Tags — на v3-пути: валидные оставить, мусор убрать", () => {
    it("оставляет английский тег", () => {
      expect(sanitizeV3Tags("[warmly] Привет, сэр.")).toBe("[warmly] Привет, сэр.");
    });
    it("оставляет составной английский тег", () => {
      expect(sanitizeV3Tags("[chuckles softly] Неплохо.")).toBe("[chuckles softly] Неплохо.");
    });
    it("вырезает мусорные скобки (русские/цифры/ссылки)", () => {
      expect(sanitizeV3Tags("[см. выше] текст")).toBe("текст");
      expect(sanitizeV3Tags("[1] пункт")).toBe("пункт");
    });
  });

  describe("isV3Model", () => {
    it("распознаёт семейство eleven_v3", () => {
      expect(isV3Model("eleven_v3")).toBe(true);
      expect(isV3Model("eleven_multilingual_v2")).toBe(false);
      expect(isV3Model(undefined)).toBe(false);
    });
  });
});
