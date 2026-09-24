/**
 * Ревью 2026-09-24 (T-F6): короткие реакции владельца — разговор, а не задача; «выруби/отруби музыку/звук» — tier0.
 *
 * Живой лог 09.09: на «нет, не надо» — «Берусь, сэр» и ответ через 5 с: реплика падала в fallback роутера
 * «неизвестное = задача-действие». Реверт-проверка: убери ветку 2.6 в classifyTier — тесты на реакции упадут
 * (tier станет sonnet, conversational — undefined).
 */
import { describe, expect, it } from "vitest";
import { classifyTier, matchMediaIntent } from "./index.js";

describe("T-F6: короткая реакция без командного глагола — разговор (не задача, не промоушен)", () => {
  it.each([
    "нет",
    "Нет, не надо.",
    "не надо",
    "понял",
    "вообще хорошо сейчас стало",
    "да, не просил ничего останавливать",
    "Джарвис, нет, не надо",
  ])("«%s» → conversational, reaction=other", (phrase) => {
    const d = classifyTier(phrase);
    expect(d.conversational, phrase).toBe(true);
    expect(d.tier).not.toBe("sonnet");
    expect(d.reaction).toBe("other");
  });

  it.each(["да", "хорошо", "ладно", "да, давай"])("«%s» → conversational, reaction=affirm (агент решит по контексту)", (phrase) => {
    const d = classifyTier(phrase);
    expect(d.conversational, phrase).toBe(true);
    expect(d.reaction).toBe("affirm");
  });

  it("«хорошо, спасибо» — закрытие разговора, а не согласие на действие (other)", () => {
    expect(classifyTier("хорошо, спасибо").reaction).toBe("other");
    expect(classifyTier("да, всё").reaction).toBe("other");
  });

  it("«ок/ага» — трёп с флагом реакции (согласие после вопроса Джарвиса подтверждает действие)", () => {
    expect(classifyTier("ок")).toMatchObject({ conversational: true, reaction: "affirm" });
    expect(classifyTier("ага")).toMatchObject({ conversational: true, reaction: "affirm" });
    expect(classifyTier("спасибо").reaction).toBe("other");
  });

  it.each([
    "нет, открой ютуб",
    "да, отправляй",
    "хорошо, сделай тише громкость в дискорде",
    "нет, не надо ничего удалять", // отрицаемый командный глагол — консервативно прежний путь
    "да, запиши это в заметки",
    "нет, лучше напиши Кате",
  ])("с командным глаголом «%s» — НЕ реакция (прежний путь)", (phrase) => {
    const d = classifyTier(phrase);
    expect(d.reaction, phrase).toBeUndefined();
  });

  it("содержательное слово вне allowlist — не реакция («нет, в доте»)", () => {
    expect(classifyTier("нет, в доте тормозит").reaction).toBeUndefined();
  });
});

describe("T-F6: «выруби/вырубай/отруби музыку/видео/звук» — мгновенный tier0, как «выключи/останови музыку»", () => {
  it.each(["выруби музыку", "вырубай видео", "отруби музыку", "выруби видео на ютубе"])("«%s» → media pause", (phrase) => {
    expect(matchMediaIntent(phrase)).toEqual({ kind: "media", op: "pause" });
    expect(classifyTier(phrase).tier).toBe("tier0");
  });

  it.each(["выруби звук", "отруби звук", "вырубай звук"])("«%s» → volume mute", (phrase) => {
    expect(matchMediaIntent(phrase)).toEqual({ kind: "volume", op: "mute" });
  });

  it("голое «выруби» — не медиа (объект обязателен)", () => {
    expect(matchMediaIntent("выруби")).toBeUndefined();
  });
});
