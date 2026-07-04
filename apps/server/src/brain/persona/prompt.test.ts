import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./index.js";

// §15: язык/контекст из настроек UI проходят в динамический хвост системного промпта.
describe("buildSystemPrompt — контекст/язык из настроек (§15)", () => {
  it("свободный контекст пользователя попадает в промпт", () => {
    const { dynamicSuffix } = buildSystemPrompt({ context: "Зовут Антон. На «ты». Зал пн/ср/пт." });
    expect(dynamicSuffix).toContain("О пользователе (со слов пользователя): Зовут Антон. На «ты». Зал пн/ср/пт.");
  });

  it("не-русский язык добавляет инструкцию общения; русский (дефолт) — нет", () => {
    expect(buildSystemPrompt({ language: "en" }).dynamicSuffix).toContain(
      "Общайся с пользователем на английском языке.",
    );
    expect(buildSystemPrompt({ language: "ru" }).dynamicSuffix).not.toContain("Общайся с пользователем");
  });

  it("пустой/пробельный контекст не плодит строку", () => {
    expect(buildSystemPrompt({ context: "   " }).dynamicSuffix).not.toContain("О пользователе");
  });

  // §8: навык вынесен в ОТДЕЛЬНЫЙ skillSuffix (кешируется своим брейкпоинтом), НЕ в динамику.
  it("выученный навык идёт в skillSuffix, а НЕ в dynamicSuffix", () => {
    const r = buildSystemPrompt({
      learnedSkill: "Процедура: открыть отчёт и отправить в Telegram.",
      context: "Зовут Антон.",
    });
    expect(r.skillSuffix).toContain("Подходящий выученный навык");
    expect(r.skillSuffix).toContain("открыть отчёт и отправить в Telegram");
    expect(r.dynamicSuffix).not.toContain("выученный навык"); // навык НЕ в некешируемой динамике
    expect(r.dynamicSuffix).toContain("Зовут Антон."); // контекст — остаётся в динамике
    expect(r.full).toContain("открыть отчёт"); // но в склейке присутствует
  });

  it("без навыка skillSuffix пустой", () => {
    expect(buildSystemPrompt({ context: "x" }).skillSuffix).toBe("");
  });

  it("каталог выученных навыков (Фаза 3) идёт в НЕкешируемый dynamicSuffix, НЕ в кешируемый skillSuffix", () => {
    const r = buildSystemPrompt({ skillCatalog: "• Отправить Герману — когда написать Herman" });
    expect(r.dynamicSuffix).toContain("Твои выученные навыки");
    expect(r.dynamicSuffix).toContain("Отправить Герману");
    expect(r.skillSuffix).toBe(""); // каталог НЕ в кеш-блоке (меняется по факту промаха)
  });

  // §20: «недавние задачи» (для «сделал?») идут в НЕкешируемый динамический хвост — иначе кеш §15 ломался бы
  // каждый ход (относительное время меняется). НЕ в staticPrefix (кешируемая персона).
  it("recentTasks попадает в dynamicSuffix, а НЕ в staticPrefix (кеш §15)", () => {
    const block = "# Недавно выполненные задачи (§20)\n- ✓ Таблица — 5 мин назад: готово";
    const r = buildSystemPrompt({ recentTasks: block, context: "Зовут Антон." });
    expect(r.dynamicSuffix).toContain("Недавно выполненные задачи");
    expect(r.dynamicSuffix).toContain("Таблица — 5 мин назад");
    expect(r.staticPrefix).not.toContain("Недавно выполненные задачи"); // не в кешируемой персоне
    expect(r.dynamicSuffix).toContain("Зовут Антон."); // соседствует с контекстом пользователя
  });

  it("пустой recentTasks не плодит блок", () => {
    expect(buildSystemPrompt({ recentTasks: "  " }).dynamicSuffix).not.toContain("Недавно выполненные");
    expect(buildSystemPrompt({}).dynamicSuffix).not.toContain("Недавно выполненные");
  });
});
