/**
 * Тесты детерминированного RU-классификатора управления задачей (§20).
 *
 * Главное, что проверяем: различие §20 — «стоп» рубит только TTS (stop_tts),
 * «отмени» рубит саму задачу (cancel). Их нельзя путать.
 */
import { describe, expect, it } from "vitest";
import { classifyTaskControl } from "./control.js";

describe("classifyTaskControl (§20)", () => {
  it("различие §20: «стоп» → stop_tts, «отмени» → cancel", () => {
    expect(classifyTaskControl("стоп").kind).toBe("stop_tts");
    expect(classifyTaskControl("отмени").kind).toBe("cancel");
    // не путаются в обе стороны
    expect(classifyTaskControl("стоп")).toMatchObject({ kind: "stop_tts", confidence: "high" });
    expect(classifyTaskControl("отмени")).toMatchObject({ kind: "cancel", confidence: "high" });
  });

  it("stop_tts: оборвать только озвучку", () => {
    expect(classifyTaskControl("заткнись").kind).toBe("stop_tts");
    expect(classifyTaskControl("тихо").kind).toBe("stop_tts");
    expect(classifyTaskControl("помолчи").kind).toBe("stop_tts");
    expect(classifyTaskControl("замолчи").kind).toBe("stop_tts");
    expect(classifyTaskControl("хватит говорить").kind).toBe("stop_tts");
    expect(classifyTaskControl("не говори").kind).toBe("stop_tts");
    expect(classifyTaskControl("хватит говорить")).toMatchObject({ confidence: "high" });
  });

  it("cancel: прервать саму задачу", () => {
    expect(classifyTaskControl("отмена").kind).toBe("cancel");
    expect(classifyTaskControl("отставить").kind).toBe("cancel");
    expect(classifyTaskControl("прекрати").kind).toBe("cancel");
    expect(classifyTaskControl("прерви").kind).toBe("cancel");
    expect(classifyTaskControl("брось").kind).toBe("cancel");
    expect(classifyTaskControl("забудь про это").kind).toBe("cancel");
    expect(classifyTaskControl("не надо больше").kind).toBe("cancel");
    expect(classifyTaskControl("отмени задачу")).toMatchObject({ kind: "cancel", confidence: "high" });
  });

  it("pause: приостановить с возможностью resume", () => {
    expect(classifyTaskControl("пауза").kind).toBe("pause");
    expect(classifyTaskControl("приостанови").kind).toBe("pause");
    expect(classifyTaskControl("потом доделаешь").kind).toBe("pause");
    expect(classifyTaskControl("потом доделай").kind).toBe("pause");
    expect(classifyTaskControl("отложи").kind).toBe("pause");
    expect(classifyTaskControl("погоди с этим").kind).toBe("pause");
    expect(classifyTaskControl("на паузу").kind).toBe("pause");
  });

  it("resume: возобновить с текущего шага", () => {
    expect(classifyTaskControl("продолжи").kind).toBe("resume");
    expect(classifyTaskControl("продолжай").kind).toBe("resume");
    expect(classifyTaskControl("дальше").kind).toBe("resume");
    expect(classifyTaskControl("доделай").kind).toBe("resume");
    expect(classifyTaskControl("возобнови").kind).toBe("resume");
  });

  it("status: отчёт о текущем прогрессе", () => {
    expect(classifyTaskControl("что делаешь").kind).toBe("status");
    expect(classifyTaskControl("что ты делаешь").kind).toBe("status");
    expect(classifyTaskControl("как там").kind).toBe("status");
    expect(classifyTaskControl("как дела с задачей").kind).toBe("status");
    expect(classifyTaskControl("на чём ты").kind).toBe("status");
    expect(classifyTaskControl("готово").kind).toBe("status");
    expect(classifyTaskControl("что по задаче").kind).toBe("status");
    expect(classifyTaskControl("докладывай").kind).toBe("status");
  });

  it("none: обычная реплика/контент", () => {
    expect(classifyTaskControl("открой блокнот")).toMatchObject({ kind: "none", confidence: "high" });
    expect(classifyTaskControl("какая погода")).toMatchObject({ kind: "none", confidence: "high" });
    expect(classifyTaskControl("расскажи анекдот").kind).toBe("none");
  });

  it("пустой/пробельный ввод → none/high", () => {
    expect(classifyTaskControl("")).toMatchObject({ kind: "none", confidence: "high" });
    expect(classifyTaskControl("   ")).toMatchObject({ kind: "none", confidence: "high" });
  });

  it("пограничные случаи → confidence low (эскалация на Haiku)", () => {
    // «стоп» рядом со словом про задачу — TTS или задача? → low
    const ambiguousStop = classifyTaskControl("стоп задачу");
    expect(ambiguousStop.confidence).toBe("low");
    // «хватит» без «говорить» — двусмысленно → low
    const bareHvatit = classifyTaskControl("хватит уже");
    expect(bareHvatit.confidence).toBe("low");
  });

  it("устойчивость к регистру и пунктуации", () => {
    expect(classifyTaskControl("СТОП!").kind).toBe("stop_tts");
    expect(classifyTaskControl("  Отмени, пожалуйста.  ").kind).toBe("cancel");
    expect(classifyTaskControl("Что делаешь?").kind).toBe("status");
  });
});
