/**
 * W1-D1 (стенд, закон 1): клик «Оплатить» по ref увёл страницу (POST-форма) — оплата ПРОШЛА, а executeScript расширения
 * вернулся без результата. Раньше инструмент отвечал «Не вышло «click» … act{target:{x,y}} клик по координатам» и
 * открывал координатный хатч — модель жала бы снова (двойная оплата). Теперь расширение отдаёт page_gone (вкладка на
 * месте) или navigated+uncertain (вкладка ушла); сервер — «НЕ ЗНАЮ, сработало ли — сверь» без хатча. Фикстуры — РЕАЛЬНАЯ
 * форма ответа моста: tab.act → {ok:false, error:"page_gone: …", code:"page_gone"} → extReplyError.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { extReplyError } from "./ext-errors.js";
import { canvasClickAllowed } from "./handlers/browser.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
type Ext = NonNullable<ToolContext["ext"]>;
const BANK = "https://online.sberbank.ru/";

function ext(over: Partial<Ext> = {}): Ext {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 42 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: BANK, count: 1, elements: [{ name: "Оплатить", ref: "e9_0", role: "button", selector: "#payform > button:nth-of-type(1)", tag: "button" }] })),
    tabAct: vi.fn(async () => ({ ok: true })),
    tabBatch: vi.fn(async () => ({ ok: true, done: 1, total: 1 })),
    tabList: vi.fn(async () => ({ tabs: [{ tabId: 42, url: BANK, status: "complete", active: true }], count: 1 })),
    tabClose: vi.fn(async () => ({ closed: 1 })),
    exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
    ...over,
  };
}
const makeCtx = (e: Ext): ToolContext =>
  ({ session: { sendAction: vi.fn<Send>(async () => ({ commandId: "c", ok: true, durationMs: 1 })) }, userId: "u1", ext: e, confirm: vi.fn(async () => ({ approved: true, outcome: "approved" as const })) }) as unknown as ToolContext;
const text = (r: { content: unknown }): string => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
const pageGone = () => extReplyError("page_gone: страница сменила документ во время «click» и результата не вернула — исход неизвестен, действие могло сработать", "page_gone");

async function payClick(e: Ext) {
  const ctx = makeCtx(e);
  await dispatchTool("browser_inspect", { url: BANK, tabId: 42 }, ctx);
  const r = await dispatchTool("browser_act", { url: BANK, tabId: 42, intent: "click", ref: "e9_0" }, ctx);
  return { r, ctx };
}

describe("W1-D1: клик увёл страницу без результата — «не знаю», а не «не вышло»", () => {
  it("page_gone (вкладка на месте) → uncertain, НЕ ЗНАЮ, без координатного хатча", async () => {
    const { r, ctx } = await payClick(ext({ tabAct: vi.fn(async () => { throw pageGone(); }) }));
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBe(true);
    expect(text(r)).toMatch(/НЕ ЗНАЮ, сработало ли/u);
    expect(text(r)).not.toMatch(/Не вышло|act\{target/u);
    expect(canvasClickAllowed(ctx)).toBe(false);
  });

  it("старое расширение («tab.act click: executeScript без результата», без кода) — тот же честный исход", async () => {
    const { r, ctx } = await payClick(ext({ tabAct: vi.fn(async () => { throw new Error("tab.act click: executeScript без результата"); }) }));
    expect(r.uncertain).toBe(true);
    expect(text(r)).not.toMatch(/Не вышло/u);
    expect(canvasClickAllowed(ctx)).toBe(false);
  });

  it("вкладка ушла (navigated + uncertain) → не ошибка, «исход НЕ подтверждён — сверь», verify-долг не снят", async () => {
    const nav = { ok: true, navigated: "https://online.sberbank.ru/pay", uncertain: true, note: "страница перешла во время действия — исход не подтверждён" };
    const { r } = await payClick(ext({ tabAct: vi.fn(async () => nav) }));
    expect(r.isError).toBe(false);
    expect(r.observed).not.toBe(true);
    expect(text(r)).toMatch(/исход самого действия НЕ подтверждён/u);
  });

  it("чтение (getValue) без результата — «перезагрузилась, повтори», без uncertain и без хатча", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("page_gone: страница перезагрузилась во время «getValue» — результата нет. Повтори", "page_gone"); }) });
    const ctx = makeCtx(e);
    const r = await dispatchTool("browser_act", { url: BANK, tabId: 42, intent: "getValue", selector: "body" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBeUndefined();
    expect(text(r)).toMatch(/перезагрузилась во время действия — результата нет. Повтори/u);
    expect(canvasClickAllowed(ctx)).toBe(false);
  });

  it("берст: шаг-клик упал page_gone → НЕ ЗНАЮ; в журнал — «шаг ушёл», выполненным его не считаем", async () => {
    const reply = { ok: false, stoppedAt: 1, done: 1, total: 2, code: "page_gone", results: [{ step: 0, ok: true, intent: "type", result: { ok: true, value: "100" } }, { step: 1, ok: false, intent: "click", error: pageGone().message }], error: "шаг 2 («click») не выполнен: " + pageGone().message };
    const r = await dispatchTool("browser_batch", { url: "https://shop.example/", steps: [{ ref: "e1_0", intent: "type", params: { text: "100" } }, { ref: "e1_1", intent: "click" }] }, makeCtx(ext({ tabBatch: vi.fn(async () => reply) })));
    expect(r.uncertain).toBe(true);
    expect(text(r)).toMatch(/НЕ ЗНАЮ/u);
    expect([r.partialSteps, r.partialInjected]).toEqual([1, true]);
  });
});
