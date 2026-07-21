import { describe, expect, it } from "vitest";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { KnowledgeBase } from "../knowledge/index.js";

function ctx(kb?: KnowledgeBase): ToolContext {
  return { session: { sendAction: async () => ({ commandId: "c", ok: true, durationMs: 1 }) }, userId: "u1", knowledge: kb } as unknown as ToolContext;
}

describe("knowledge_consult через dispatch (§экспертность)", () => {
  it("возвращает экспертные принципы по запросу", async () => {
    const r = await dispatchTool("knowledge_consult", { domain: "trading", query: "риск размер позиции стоп" }, ctx(new KnowledgeBase()));
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toMatch(/риск/i);
    expect(String(r.content)).toMatch(/untrusted|разделы/i); // обёрнуто как данные + оглавление
  });

  it("пустой domain → честная ошибка с подсказкой доступных доменов", async () => {
    const r = await dispatchTool("knowledge_consult", { domain: "", query: "x" }, ctx(new KnowledgeBase()));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/trading/);
  });

  it("нет базы знаний → честная ошибка", async () => {
    const r = await dispatchTool("knowledge_consult", { domain: "trading", query: "x" }, ctx(undefined));
    expect(r.isError).toBe(true);
  });

  // Аудит контекста 2026-07-20: промах не маскируется intro — честно «нет раздела» + оглавление, без untrusted.
  it("непопавший запрос (домен есть, раздела нет) → честный статус, НЕ выдаёт intro за консультацию", async () => {
    const r = await dispatchTool("knowledge_consult", { domain: "trading", query: "фотосинтез кенгуру балалайка" }, ctx(new KnowledgeBase()));
    expect(r.isError).toBeFalsy(); // не ошибка (домен есть, запрос валиден) — но честный «нет раздела»
    expect(String(r.content)).toMatch(/нет раздела под запрос/i);
    expect(String(r.content)).not.toContain("untrusted_content"); // это НАШ статус, не внешние данные
    expect(String(r.content)).toMatch(/уточни запрос|web_search/i); // подсказка, что делать
  });
});
