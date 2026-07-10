import { describe, expect, it } from "vitest";
import { bestTextMatch, type ClickCandidate } from "./ui-match.js";

const c = (text: string, aria?: string): ClickCandidate => ({ text, aria });

describe("bestTextMatch — робастный клик по тексту (Фаза 5, без ложных подстрок)", () => {
  it("ОПАСНЫЙ кейс: короткое «да» НЕ цепляет «Удалить» (удалить.includes(да)), берёт «Да, отправить»", () => {
    const i = bestTextMatch("да", [c("Удалить"), c("Да, отправить"), c("Отмена")]);
    expect(i).toBe(1); // целое слово «да», а НЕ подстрока в «Удалить»
  });

  it("короткое «ок» не цепляет «Блокировать»", () => {
    expect(bestTextMatch("ок", [c("Блокировать"), c("Разблокировать")])).toBe(-1); // нет слова «ок»
    expect(bestTextMatch("ок", [c("ОК"), c("Отмена")])).toBe(0); // точное
  });

  it("точное совпадение > всего", () => {
    expect(bestTextMatch("отправить", [c("Отправить файл"), c("Отправить")])).toBe(1);
  });

  it("целое слово в тексте", () => {
    expect(bestTextMatch("сохранить", [c("Отмена"), c("Сохранить изменения")])).toBe(1);
  });

  it("aria-label учитывается наравне с текстом", () => {
    expect(bestTextMatch("воспроизвести", [c("", "Воспроизвести"), c("", "Пауза")])).toBe(0);
  });

  it("длинный запрос (≥4) допускает подстроку/префикс", () => {
    expect(bestTextMatch("настр", [c("Настройки")])).toBe(0); // префикс
    expect(bestTextMatch("файлы", [c("Мои файлы тут")])).toBe(0); // целое слово
  });

  it("нет совпадения → -1; пустой запрос → -1; диакритика/ё свёрнуты", () => {
    expect(bestTextMatch("xyz", [c("Отправить")])).toBe(-1);
    expect(bestTextMatch("  ", [c("Отправить")])).toBe(-1);
    expect(bestTextMatch("ещё", [c("Ещё действия")])).toBe(0); // ё→е fold
  });
});
