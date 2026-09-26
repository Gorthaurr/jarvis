/**
 * Стенд: сценарный мозг — ходы петли по порядку, побочные вызовы (без sessionKey) скрипт не съедают, исчерпание —
 * честный стаб, $ref/$match подставляются из истории петли. Реверт-проверка: убрать ветку «без sessionKey → стаб» —
 * падает второй тест; сломать findRef (вхождение вместо точного) — падает «точная подпись важнее вхождения».
 */
import { describe, expect, it } from "vitest";
import type { LlmMessage, LlmRequest } from "../../integrations/llm.js";
import { ScriptedLlm, parseScript } from "./scripted-llm.js";
import { findRef, inspectElements, resolvePlaceholders } from "./script-refs.js";
import { wrapUntrusted } from "../../brain/tools/dispatch-util.js";

const req = (messages: LlmMessage[], sessionKey?: string): LlmRequest =>
  ({ tier: "sonnet", model: "m", systemStatic: "", messages, ...(sessionKey ? { sessionKey } : {}) }) as LlmRequest;

const snapshot = (elements: unknown[]): string =>
  wrapUntrusted("DOM вкладки https://online.sberbank.ru/pay", JSON.stringify({ url: "https://online.sberbank.ru/pay", elements }));

const withResult = (text: string): LlmMessage[] => [
  { role: "user", content: "оплати" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser_inspect", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
];

describe("ScriptedLlm", () => {
  it("отдаёт ходы по порядку: tool_use → финальный текст", async () => {
    const llm = new ScriptedLlm([{ tool_uses: [{ name: "browser_read", input: {} }] }, { text: "Готово, сэр." }]);
    const a = await llm.complete(req([{ role: "user", content: "x" }], "task1"));
    const b = await llm.complete(req(withResult("ok"), "task1"));
    expect(a).toMatchObject({ stopReason: "tool_use", stubbed: false });
    expect(a.toolUses[0]?.name).toBe("browser_read");
    expect(b).toMatchObject({ text: "Готово, сэр.", stopReason: "end_turn", toolUses: [] });
    expect(llm.summary()).toMatchObject({ loopCalls: 2, sideCalls: 0, exhausted: false });
    expect(llm.rounds[1]?.toolResults[0]?.text).toBe("ok");
  });

  it("побочный вызов без sessionKey → стаб, ход сценария не тратится", async () => {
    const llm = new ScriptedLlm([{ text: "финал" }]);
    const side = await llm.complete(req([{ role: "user", content: "рефлекс" }]));
    expect(side.stopReason).toBe("stub");
    const loop = await llm.complete(req([{ role: "user", content: "x" }], "t"));
    expect(loop.text).toBe("финал");
    expect(llm.summary()).toMatchObject({ sideCalls: 1, loopCalls: 1 });
  });

  it("скрипт кончился → стаб + exhausted (без выдуманного «Готово»)", async () => {
    const llm = new ScriptedLlm([{ text: "раз" }]);
    await llm.complete(req([{ role: "user", content: "x" }], "t"));
    const extra = await llm.complete(req([{ role: "user", content: "Сверь исход." }], "t"));
    expect(extra).toMatchObject({ stopReason: "stub", text: "", stubbed: true });
    expect(llm.summary()).toMatchObject({ exhausted: true, extraLoopCalls: 1 });
    expect(llm.rounds[1]?.userText).toBe("Сверь исход.");
  });

  it("$ref подставляется из последнего снимка browser_inspect в истории; неразрешённый — литерал + unresolved", async () => {
    const snap = snapshot([{ ref: "e1_3", name: "Оплатить", role: "button" }]);
    const llm = new ScriptedLlm([{ tool_uses: [{ name: "browser_act", input: { intent: "click", ref: "$ref:оплатить" } }, { name: "browser_act", input: { ref: "$ref:Нет такого" } }] }]);
    const r = await llm.complete(req(withResult(snap), "t"));
    expect(r.toolUses[0]?.input).toEqual({ intent: "click", ref: "e1_3" });
    expect(r.toolUses[1]?.input).toEqual({ ref: "$ref:Нет такого" });
    expect(llm.rounds[0]?.unresolved).toEqual(["$ref:Нет такого"]);
  });
});

describe("script-refs", () => {
  const els = [
    { ref: "e1_1", name: "Отправить всё и завершить тест", role: "button" },
    { ref: "e1_2", text: "Отправить", role: "button" },
    { ref: "e1_3", label: "Сумма", role: "textbox" },
  ];
  it("точная подпись важнее вхождения; ё = е; без регистра", () => {
    expect(findRef(els, "отправить")).toBe("e1_2");
    expect(findRef(els, "завершить тест")).toBe("e1_1");
    expect(findRef([{ ref: "e9", name: "Ещё" }], "еще")).toBe("e9");
  });
  it("inspectElements читает JSON из untrusted-обёртки", () => {
    expect(inspectElements(snapshot(els)).map((e) => e.ref)).toEqual(["e1_1", "e1_2", "e1_3"]);
    expect(inspectElements("просто текст")).toEqual([]);
  });
  it("$match берёт первую группу из последнего результата; вложенные объекты обходятся", () => {
    const r = resolvePlaceholders({ steps: [{ params: { to: "$match:tabId=(\\d+)" } }] }, "", "Открыл, tabId=42");
    expect(r.value).toEqual({ steps: [{ params: { to: "42" } }] });
    expect(r.resolved).toEqual({ "$match:tabId=(\\d+)": "42" });
  });
  it("parseScript: мусор → строка ошибки", () => {
    expect(typeof parseScript({ turns: [] })).toBe("string");
    expect(typeof parseScript({ turns: [{ tool_uses: [{}] }] })).toBe("string");
    expect(Array.isArray(parseScript([{ text: "ok" }]))).toBe(true);
  });
});
