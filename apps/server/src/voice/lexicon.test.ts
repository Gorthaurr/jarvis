/**
 * §Волна2 (2.6) — тесты пост-STT нормализатора лексики: доменная латиница → кириллица,
 * незнакомая латиница НЕ трогается (recall-принцип §13), словоформы через lev≤1.
 */
import { describe, expect, it } from "vitest";
import { TranscriptNormalizer, buildLexicon, normalizeTranscript, withinLev1 } from "./lexicon.js";

describe("withinLev1", () => {
  it("равные и на расстоянии 1", () => {
    expect(withinLev1("дота", "дота")).toBe(true);
    expect(withinLev1("доте", "дота")).toBe(true); // замена
    expect(withinLev1("дот", "дота")).toBe(true); // вставка
    expect(withinLev1("дотка", "дота")).toBe(true); // удаление
  });
  it("дальше 1 — false", () => {
    expect(withinLev1("доту", "стим")).toBe(false);
    expect(withinLev1("телеграм", "инстаграм")).toBe(false);
  });
});

describe("buildLexicon", () => {
  it("токены терминов + кириллический рендеринг латинских", () => {
    const lex = buildLexicon(["Dota 2", "ютуб"]);
    expect(lex.has("dota")).toBe(true);
    expect(lex.has("дота")).toBe(true); // latinToCyrillic("dota")
    expect(lex.has("ютуб")).toBe(true);
  });
});

describe("normalizeTranscript", () => {
  const lex = buildLexicon(["Dota 2", "ютуб", "стим"]);

  it("живой кейс эпизода: «в dot'е.» → «в доте.» (словоформа и пунктуация сохранены)", () => {
    expect(normalizeTranscript("запусти поиск в dot'е.", lex)).toBe("запусти поиск в доте.");
  });

  it("незнакомая латиница НЕ трогается (пользователь мог назвать реальный термин)", () => {
    const t = "открой GitHub и ffmpeg";
    expect(normalizeTranscript(t, lex)).toBe(t);
  });

  it("чисто-кириллический текст не меняется вовсе", () => {
    const t = "запусти поиск в доте";
    expect(normalizeTranscript(t, lex)).toBe(t);
  });

  it("пустой лексикон → текст как есть", () => {
    expect(normalizeTranscript("в dot'е", new Set())).toBe("в dot'е");
  });
});

describe("TranscriptNormalizer", () => {
  it("до первой сборки — текст как есть; после — нормализует (sync API)", async () => {
    const n = new TranscriptNormalizer([() => ["дота"]]);
    // Первый вызов запускает фоновую сборку и отдаёт сырой текст.
    expect(n.normalize("в dot'е")).toBe("в dot'е");
    await new Promise((r) => setTimeout(r, 20)); // сборка из sync-источника — мгновенная
    expect(n.size).toBeGreaterThan(0);
    expect(n.normalize("в dot'е")).toBe("в доте");
  });

  it("упавший источник не валит сборку из остальных", async () => {
    const n = new TranscriptNormalizer([
      () => Promise.reject(new Error("бд лежит")),
      () => ["стим"],
    ]);
    n.normalize("x");
    await new Promise((r) => setTimeout(r, 20));
    expect(n.size).toBeGreaterThan(0);
  });
});
