/**
 * info-хендлеры: сигнал СКРЫТОЙ ДЕГРАДАЦИИ (пункт-6, наблюдаемость). Read-инструмент отработал без ошибки,
 * но не дал пользы (пустой web_search=[], knowledge_consult без совпадения) → durable-сигнал recordDegradation,
 * иначе «почему недоработал» невидимо (ok=true). Spy на синглтон metrics — проверяем факт/аргументы сигнала.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics } from "../../../obs/metrics.js";
import type { ToolContext } from "../dispatch.js";
import { knowledgeConsult, webFetch, webSearch } from "./info.js";

describe("info-хендлеры — сигнал деградации (пункт-6)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("web_search пусто → recordDegradation('web_search_empty') с query/userId", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => undefined);
    const ctx = { userId: "u1", web: { search: async () => [] } } as unknown as ToolContext;
    const r = await webSearch(ctx, { query: "очень редкий запрос" });
    expect(r.isError).toBeFalsy(); // не ошибка — пусто, но честно
    expect(spy).toHaveBeenCalledWith("web_search_empty", expect.objectContaining({ query: "очень редкий запрос", userId: "u1" }));
  });

  it("web_search с результатами → БЕЗ сигнала деградации", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => undefined);
    const ctx = { userId: "u1", web: { search: async () => [{ title: "t", url: "https://x", snippet: "s" }] } } as unknown as ToolContext;
    await webSearch(ctx, { query: "q" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("knowledge_consult промах (matched:false) → recordDegradation('knowledge_miss') с domain/query", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => undefined);
    const ctx = {
      userId: "u1",
      knowledge: { domains: () => ["trading"], consult: () => ({ found: true, matched: false, text: "", topics: ["risk", "entry"] }) },
    } as unknown as ToolContext;
    const r = await knowledgeConsult(ctx, { domain: "trading", query: "тема без раздела" });
    expect(r.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledWith("knowledge_miss", expect.objectContaining({ domain: "trading", query: "тема без раздела" }));
  });

  it("knowledge_consult совпадение (matched:true) → БЕЗ сигнала", async () => {
    const spy = vi.spyOn(metrics, "recordDegradation").mockImplementation(() => undefined);
    const ctx = {
      userId: "u1",
      knowledge: { domains: () => ["trading"], consult: () => ({ found: true, matched: true, text: "знание", topics: ["risk"] }) },
    } as unknown as ToolContext;
    await knowledgeConsult(ctx, { domain: "trading", query: "risk" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("web_fetch — усечение по maxChars не выдаёт обрезок за весь документ", () => {
  // 🔴 Адверс-ревью 2026-09-01: шапка web.ts обещает «усечение всегда помечается явно», а метку
  // `[УСЕЧЕНО…]` web.ts дописывает В КОНЕЦ текста — срез по maxChars выбрасывал её ПЕРВОЙ. Модель
  // получала молча обрезанную страницу и делала выводы о том, чего в ней «нет».
  const ctxWith = (text: string) =>
    ({ userId: "u1", web: { fetch: async () => ({ url: "https://x", title: "T", text }) } }) as unknown as ToolContext;

  it("текст длиннее maxChars → в ответе есть явная метка усечения", async () => {
    const r = await webFetch(ctxWith("a".repeat(5000)), { url: "https://x", maxChars: 100 });
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("УСЕЧЕНО");
    expect(String(r.content)).toContain("maxChars=100");
  });

  it("текст короче maxChars → метки НЕТ (не пугаем усечением, которого не было)", async () => {
    const r = await webFetch(ctxWith("короткая страница"), { url: "https://x", maxChars: 100 });
    expect(String(r.content)).not.toContain("УСЕЧЕНО");
    expect(String(r.content)).toContain("короткая страница");
  });
});
