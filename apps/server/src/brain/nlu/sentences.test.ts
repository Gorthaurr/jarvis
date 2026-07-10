import { describe, expect, it } from "vitest";
import { SentenceChunker, splitIntoSentences } from "./sentences.js";

describe("SentenceChunker (§10 пофразный стрим)", () => {
  it("отдаёт предложение по границе, хвост держит в буфере", () => {
    const ch = new SentenceChunker();
    expect(ch.push("Привет")).toEqual([]);
    expect(ch.push(", сэр. Как ")).toEqual(["Привет, сэр."]);
    expect(ch.push("дела")).toEqual([]);
    expect(ch.flush()).toEqual(["Как дела"]);
  });

  it("несколько предложений в одной дельте", () => {
    const ch = new SentenceChunker();
    expect(ch.push("Раз. Два! Три? ")).toEqual(["Раз.", "Два!", "Три?"]);
    expect(ch.flush()).toEqual([]);
  });

  it("десятичная дробь, разорванная по дельтам, не рвётся на границе", () => {
    const ch = new SentenceChunker();
    expect(ch.push("Цена 3")).toEqual([]);
    expect(ch.push(".")).toEqual([]); // «.» последний символ — ждём, возможна дробь
    expect(ch.push("14 рубля")).toEqual([]); // 3.14 — не граница
    expect(ch.flush()).toEqual(["Цена 3.14 рубля"]);
  });

  it("точка-конец-предложения после цифры всё же эмитится, когда дальше не цифра", () => {
    const ch = new SentenceChunker();
    expect(ch.push("Готово 5")).toEqual([]);
    expect(ch.push(".")).toEqual([]); // ждём следующую дельту
    expect(ch.push(" Хорошо")).toEqual(["Готово 5."]); // следующий символ — пробел, значит конец
    expect(ch.flush()).toEqual(["Хорошо"]);
  });

  it("граница может прийти разбитой по дельтам (по одному символу)", () => {
    const ch = new SentenceChunker();
    const got: string[] = [];
    for (const c of "Готово.") got.push(...ch.push(c));
    expect(got).toEqual(["Готово."]);
  });

  it("перенос строки — тоже граница", () => {
    const ch = new SentenceChunker();
    expect(ch.push("Пункт один\nПункт два\n")).toEqual(["Пункт один", "Пункт два"]);
  });

  it("проглатывает набегающие терминаторы и закрывающие кавычки", () => {
    const ch = new SentenceChunker();
    expect(ch.push('Серьёзно?! «Да».  Дальше.')).toEqual(['Серьёзно?!', '«Да».', "Дальше."]);
  });

  it("точка между цифрами НЕ граница (ненормализованное число)", () => {
    const ch = new SentenceChunker();
    expect(ch.push("Курс 3.14 сегодня. Дальше")).toEqual(["Курс 3.14 сегодня."]);
    expect(ch.flush()).toEqual(["Дальше"]);
  });

  it("одинокая пунктуация не эмитится отдельным звуком", () => {
    const ch = new SentenceChunker();
    // Терминатор без слова перед ним — пустое «предложение», в TTS не отдаём (нет звука).
    expect(ch.push("…")).toEqual([]);
    expect(ch.push("Ну вот.")).toEqual(["Ну вот."]);
  });

  it("незавершённый хвост без границы держится и копится между дельтами", () => {
    const ch = new SentenceChunker();
    expect(ch.push("Так")).toEqual([]);
    expect(ch.push(" вот")).toEqual([]);
    expect(ch.push(", сэр.")).toEqual(["Так вот, сэр."]);
  });

  it("flush с пустым/пунктуационным остатком ничего не отдаёт, а с содержимым — отдаёт", () => {
    const ch = new SentenceChunker();
    ch.push("   ");
    expect(ch.flush()).toEqual([]);
    const ch2 = new SentenceChunker();
    ch2.push("Конец без точки"); // без терминатора — держится в буфере до flush
    expect(ch2.flush()).toEqual(["Конец без точки"]);
  });

  it("hasPending отражает незавершённый хвост", () => {
    const ch = new SentenceChunker();
    ch.push("Думаю");
    expect(ch.hasPending).toBe(true);
    ch.push(".");
    ch.push(""); // drain
    expect(ch.hasPending).toBe(false);
  });

  it("splitIntoSentences — нестримовый эквивалент", () => {
    expect(splitIntoSentences("Первое. Второе! Третье?")).toEqual(["Первое.", "Второе!", "Третье?"]);
    expect(splitIntoSentences("Одно предложение без точки")).toEqual(["Одно предложение без точки"]);
    expect(splitIntoSentences("")).toEqual([]);
  });
});
