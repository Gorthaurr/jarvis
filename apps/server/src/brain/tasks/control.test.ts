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
    expect(classifyTaskControl("тихо").kind).toBe("stop_tts");
    expect(classifyTaskControl("хватит говорить").kind).toBe("stop_tts");
    // B-F2: «замолчи» внутри длинной фразы — по-прежнему только озвучка (рефлекс — для короткой команды).
    expect(classifyTaskControl("замолчи и выключи музыку на ютубе").kind).toBe("stop_tts");
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
    expect(classifyTaskControl("что по задаче").kind).toBe("status");
    expect(classifyTaskControl("докладывай").kind).toBe("status");
    // «готово» (закрытие/спасибо) — НЕ статус: не перехватываем, пусть идёт агенту как обычная реплика.
    expect(classifyTaskControl("всё, готово, спасибо").kind).toBe("none");
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
    // «хватит» С СОДЕРЖАНИЕМ, но без «говорить» — двусмысленно → low (голое «хватит [уже]» — kill, см. B-F2)
    const hvatitWithContent = classifyTaskControl("хватит на сегодня");
    expect(hvatitWithContent.confidence).toBe("low");
  });

  it("устойчивость к регистру и пунктуации", () => {
    expect(classifyTaskControl("СТОП!").kind).toBe("stop_tts");
    expect(classifyTaskControl("  Отмени, пожалуйста.  ").kind).toBe("cancel");
    expect(classifyTaskControl("Что делаешь?").kind).toBe("status");
  });
});

describe("W0 рефлекс kill/silence (2026-09-09, лог «Джарвис, вырубись» ×3 → три LLM-задачи)", () => {
  it("возвратные формы и «X себя» — kill, а не cancel/stop_tts и не контент", () => {
    for (const phrase of [
      "вырубись",
      "Джарвис, вырубись,.",
      "выключись",
      "отключись нахуй",
      "заглохни",
      "выруби себя",
      "выключи себя",
      "выруби клот и себя, нахуй.",
      "Себя нахуй выруби просто урод ты.",
      "закрой себя",
    ]) {
      expect(classifyTaskControl(phrase), phrase).toMatchObject({ kind: "kill", confidence: "high" });
    }
  });

  it("глагол выключения с ДРУГИМ объектом — не kill (это команда программе, идёт в роутер)", () => {
    expect(classifyTaskControl("выруби музыку").kind).toBe("none");
    expect(classifyTaskControl("выключи компьютер").kind).toBe("none");
    expect(classifyTaskControl("отключи вайфай").kind).toBe("none");
    expect(classifyTaskControl("закрой браузер").kind).toBe("none");
  });

  it("короткое «тишина/молчи» — silence; длинная фраза с этим словом — обычная реплика", () => {
    expect(classifyTaskControl("тишина").kind).toBe("silence");
    expect(classifyTaskControl("Джарвис, тишина").kind).toBe("silence");
    expect(classifyTaskControl("полная тишина").kind).toBe("silence");
    expect(classifyTaskControl("в комнате наступила полная тишина и покой").kind).toBe("none");
  });

  it("B-F2 (ревью 2026-09-24): «заткнись/замолчи/помолчи» и «да замолчи ты уже» — рефлекс silence, а не задача модели", () => {
    // Реверт: убери эти слова из SILENCE_WORDS (или счёт без филлеров) — тест упадёт (stop_tts → в модель при молчащем Джарвисе).
    for (const phrase of ["заткнись", "замолчи", "помолчи", "да замолчи ты уже", "Джарвис, заткнись!", "замолчи, тебе говорю"]) {
      expect(classifyTaskControl(phrase), phrase).toMatchObject({ kind: "silence", confidence: "high" });
    }
    // «не молчи» — просьба говорить, не рефлекс тишины.
    expect(classifyTaskControl("не молчи").kind).not.toBe("silence");
  });

  it("B-F2: голое «хватит» (с филлерами) — kill-рефлекс; «хватит» с содержанием — нет", () => {
    for (const phrase of ["хватит", "хватит уже", "да хватит!", "всё, хватит", "Джарвис, хватит"]) {
      expect(classifyTaskControl(phrase), phrase).toMatchObject({ kind: "kill", confidence: "high" });
    }
    expect(classifyTaskControl("хватит говорить").kind).toBe("stop_tts");
    expect(classifyTaskControl("хватит на сегодня музыки").kind).not.toBe("kill");
  });

  it("kill берёт верх над cancel-словом в той же фразе («прекрати и вырубись» — это про самого Джарвиса)", () => {
    expect(classifyTaskControl("прекрати и вырубись").kind).toBe("kill");
  });
});
