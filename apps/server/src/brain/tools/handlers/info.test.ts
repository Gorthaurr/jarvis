/**
 * info-хендлеры: сигнал СКРЫТОЙ ДЕГРАДАЦИИ (пункт-6, наблюдаемость). Read-инструмент отработал без ошибки,
 * но не дал пользы (пустой web_search=[], knowledge_consult без совпадения) → durable-сигнал recordDegradation,
 * иначе «почему недоработал» невидимо (ok=true). Spy на синглтон metrics — проверяем факт/аргументы сигнала.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics } from "../../../obs/metrics.js";
import type { ToolContext } from "../dispatch.js";
import { knowledgeConsult, webSearch } from "./info.js";

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
