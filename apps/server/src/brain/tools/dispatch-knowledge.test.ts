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
});
