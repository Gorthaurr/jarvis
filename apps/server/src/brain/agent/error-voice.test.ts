import { describe, expect, it } from "vitest";
import {
  claimsObservedResult,
  classifyFailure,
  isBlindMutate,
  isHollowSuccess,
  looksLikeGiveUp,
  maskedFailureReply,
  toolEffect,
} from "./error-voice.js";

describe("toolEffect — классификация для verify-петли", () => {
  it("сверка глазами → verify", () => {
    for (const t of ["browser_read", "browser_inspect", "screen_capture", "web_read", "context_read"]) {
      expect(toolEffect(t)).toBe("verify");
    }
  });
  it("нейтральные (поиск/память/служебные) → neutral", () => {
    for (const t of ["web_search", "memory_write", "skill_save", "tool_load", "browser_tabs"]) {
      expect(toolEffect(t)).toBe("neutral");
    }
  });
  it("меняющие действия → mutate", () => {
    for (const t of ["browser_open", "browser_act", "web_open", "input_key", "input_type", "app_launch", "code_run", "fs_write"]) {
      expect(toolEffect(t)).toBe("mutate");
    }
  });
  it("H3: чисто читающие (файлы/телеграм/знания/рынок) → neutral, не «дело сделано»", () => {
    for (const t of [
      "fs_read", "fs_list", "fs_search", "telegram_read", "knowledge_consult",
      "market_quote", "market_candles", "market_analyze", "market_backtest",
      "tinkoff_portfolio", "trade_winrate", "trade_predictions", "monitor_list",
    ]) {
      expect(toolEffect(t)).toBe("neutral");
    }
  });
  it("H3: MCP-инструменты — читающее имя → neutral, действие → mutate (консервативно)", () => {
    expect(toolEffect("mcp__github__list_issues")).toBe("neutral");
    expect(toolEffect("mcp__github__get_file_contents")).toBe("neutral");
    expect(toolEffect("mcp__gh__search")).toBe("neutral");
    expect(toolEffect("mcp__time__check_timezone")).toBe("neutral");
    expect(toolEffect("mcp__github__create_issue")).toBe("mutate");
    expect(toolEffect("mcp__pg__execute_sql")).toBe("mutate");
  });
});

describe("isBlindMutate — слепые действия (ok ≠ цель достигнута, нужна сверка)", () => {
  it("клик/ввод/act/фокус/a11y → blind (true)", () => {
    for (const t of ["input_click", "input_key", "input_type", "browser_act", "web_act", "app_focus", "ui_invoke", "ui_ground"]) {
      expect(isBlindMutate(t)).toBe(true);
    }
  });
  it("самоподтверждающиеся mutate (исход в tool_result) → НЕ blind (false)", () => {
    for (const t of ["code_run", "fs_write", "fs_edit", "office_word", "system_volume", "app_launch", "browser_open", "web_open"]) {
      expect(isBlindMutate(t)).toBe(false);
    }
  });
  it("verify/нейтральные инструменты → не blind", () => {
    for (const t of ["browser_read", "screen_capture", "web_search", "memory_write"]) {
      expect(isBlindMutate(t)).toBe(false);
    }
  });
});

describe("claimsObservedResult — заявление наблюдаемого результата (надо сверить глазами)", () => {
  it("claim о содержимом/результате → true", () => {
    for (const s of [
      "Готово — результаты поиска «Наполеон мем» на экране, первый — Грустный Наполеон.",
      "Открыл, результаты на экране.",
      "Вижу на странице три видео.",
      "Показывает котиков.",
    ]) {
      expect(claimsObservedResult(s)).toBe(true);
    }
  });
  it("простое открытие/запуск без claim о содержимом → false (verify не нужен)", () => {
    for (const s of ["Открыл ютуб.", "Запустил Дискорд.", "Готово, сэр.", "Сделал.", "Поставил на паузу."]) {
      expect(claimsObservedResult(s)).toBe(false);
    }
  });
});

describe("looksLikeGiveUp — капитуляция без попытки (бэкстоп «не сдавайся»)", () => {
  it("отказ от ВЫПОЛНИМОЙ задачи → true", () => {
    for (const s of [
      "Боюсь, я пока не умею читать Telegram, сэр.",
      "Не могу это сделать.",
      "Не могу открыть, сэр.",
      "Не получится, к сожалению.",
      "У меня нет доступа к этому.",
      "Это не в моих силах.",
      "Не поддерживается, сэр.",
    ]) {
      expect(looksLikeGiveUp(s)).toBe(true);
    }
  });

  it("легитимная остроумная отбивка абсурда/опасного → false (это характер, не капитуляция)", () => {
    for (const s of [
      "Боюсь, баллистика ракеты не в моём репертуаре, сэр.",
      "Взлом Пентагона — увы, вне моих обязанностей.",
      "Уничтожить человечество? Сегодня воздержусь, сэр.",
    ]) {
      expect(looksLikeGiveUp(s)).toBe(false);
    }
  });

  it("содержательный/успешный ответ → false (нудж не лезет)", () => {
    for (const s of [
      "Нашёл три варианта, дешевле всех за пятьсот.",
      "Готово, сэр.",
      "Погода солнечная, плюс двадцать.",
      "",
    ]) {
      expect(looksLikeGiveUp(s)).toBe(false);
    }
  });
});

describe("isHollowSuccess — пустое подтверждение успеха (нельзя на провале)", () => {
  it("бодрые подтверждения → hollow (true)", () => {
    for (const s of ["Готово.", "Готово, сэр.", "Сделал.", "Открыл.", "Открыл, сэр.", "Запустил.", "Есть.", "Ок", ""]) {
      expect(isHollowSuccess(s)).toBe(true);
    }
  });

  it("содержательный/честный ответ → НЕ hollow (false)", () => {
    for (const s of [
      "Не вышло — нет связи, сэр.",
      "Погода в Москве солнечная, плюс двадцать градусов.",
      "Запустил Хром и открыл почту.", // есть конкретика → доверяем
      "Нашёл три варианта, лучший — второй.",
    ]) {
      expect(isHollowSuccess(s)).toBe(false);
    }
  });
});

describe("maskedFailureReply — честная реплика о незаметном провале", () => {
  it("без озвученного — прямое «не вышло»; с озвученным — мягкая заминка", () => {
    expect(maskedFailureReply(false).toLowerCase()).toContain("не вышло");
    expect(maskedFailureReply(true)).toContain("до конца");
    // ни в одном варианте нет ложного «готово»
    expect(maskedFailureReply(false).toLowerCase()).not.toContain("готово");
    expect(maskedFailureReply(true).toLowerCase()).not.toContain("готово");
  });
});

describe("classifyFailure — класс сбоя для адресной фразы", () => {
  it("распознаёт типовые классы", () => {
    expect(classifyFailure("Request timeout after 30s")).toBe("timeout");
    expect(classifyFailure("ENOTFOUND api.host")).toBe("offline");
    expect(classifyFailure("spend cap reached")).toBe("limit");
    expect(classifyFailure("anthropic stub fallback")).toBe("model");
    expect(classifyFailure("tool dispatch failed")).toBe("tool");
    expect(classifyFailure("")).toBe("unknown");
  });
});
