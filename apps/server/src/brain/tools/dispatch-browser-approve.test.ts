/**
 * W1-ревью р2, зона approve (сервер): форма одобрения §14 (approvedLabel = видимое имя из снимка, approvedRef),
 * web_act судит ту клавишу, что нажмёт jarvis-browser, слова коммита, встряхивание в мессенджере. Проводка — через
 * настоящий dispatchTool; снимок — в форме inspectPageInPage (tag/role/name/text/state/selector). Сквозь страницу —
 * browser-approval-e2e.test.ts. Реверт-проверено: сломай охраняемое → тест красный.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { COMMIT_WORDS_RE } from "@jarvis/shared";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { assessWebCommit } from "./commit-gate.js";
import { extReplyError } from "./ext-errors.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
const BANK = "https://online.sberbank.ru/pay";
const TG = "https://web.telegram.org/a/";
// Элемент снимка ровно как его отдаёт inspectPageInPage (background.js): tag/role/name/state/selector всегда есть.
const PAY = { ref: "e41234_7", tag: "button", role: "button", name: "Оплатить заказ", state: {}, selector: "#pay" };

function setup(tabAct = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true })), approved = true) {
  const confirm = vi.fn(async (_s: string) => ({ approved, outcome: approved ? ("approved" as const) : ("denied" as const) }));
  const sendAction = vi.fn<Send>(async () => ({ commandId: "c", ok: true, durationMs: 1 }));
  const ext = {
    connected: true, tabAct, openOrFocus: vi.fn(async () => ({ tabId: 5 })), tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: BANK, elements: [PAY] })), tabBatch: vi.fn(async (..._a: unknown[]) => ({ ok: true, done: 1, total: 1 })),
    tabList: vi.fn(async () => ({ tabs: [] })), tabClose: vi.fn(), exportCookies: vi.fn(),
  };
  const ctx = { session: { sendAction }, userId: "u1", ext, confirm } as unknown as ToolContext;
  const params = (i = 0) => (tabAct.mock.calls[i]?.[2] ?? {}) as Record<string, unknown>;
  return { ctx, confirm, sendAction, ext, tabAct, params };
}

describe("контракт approve: одобрение = видимое имя + ref (не склейка хинта)", () => {
  it("клик по ref на банке: approvedLabel — имя без selector/role, approvedRef — ref цели", async () => {
    const { ctx, confirm, params } = setup();
    await dispatchTool("browser_inspect", { url: BANK }, ctx);
    await dispatchTool("browser_act", { url: BANK, intent: "click", ref: PAY.ref }, ctx);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(params()).toMatchObject({ guardApproved: true, approvedLabel: "Оплатить заказ", approvedRef: PAY.ref });
  });

  it("повтор после commit_confirm страницы ЗАМЕНЯЕТ прежнее одобрение (подпись страницы + ref), а не сливается с ним", async () => {
    const tabAct = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true }));
    tabAct.mockRejectedValueOnce(extReplyError("commit_confirm: ", "commit_confirm", ""));
    const { ctx, confirm, params } = setup(tabAct);
    await dispatchTool("browser_inspect", { url: BANK }, ctx);
    await dispatchTool("browser_act", { url: BANK, intent: "click", ref: PAY.ref }, ctx);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(params(1).approvedLabel).toBeUndefined(); // одобрена подпись страницы (пустая), не прежняя серверная
    expect(params(1)).toMatchObject({ guardApproved: true, approvedRef: PAY.ref });
  });

  it("берст: шаг по ref несёт approvedRef и имя; approvedRef от модели вырезается (ставит только сервер)", async () => {
    const { ctx, ext } = setup();
    await dispatchTool("browser_inspect", { url: BANK }, ctx);
    await dispatchTool("browser_batch", { url: BANK, steps: [{ intent: "click", ref: PAY.ref, params: { approvedRef: "e41234_9" } }] }, ctx);
    const step = (ext.tabBatch.mock.calls[0]?.[1] as Array<{ params: Record<string, unknown> }>)[0];
    expect(step?.params).toMatchObject({ approvedLabel: "Оплатить заказ", approvedRef: PAY.ref });
    const { ctx: c2, params } = setup();
    await dispatchTool("browser_act", { url: "https://shop.example/", intent: "click", ref: "e1_1", approvedRef: "e1_1" }, c2);
    expect(params().approvedRef).toBeUndefined();
  });
});

describe("srv-bypass-2: web_act судит клавишу, которую нажмёт jarvis-browser (params.key ?? Enter)", () => {
  const jbActs = (s: ReturnType<typeof vi.fn>) => s.mock.calls.filter((c) => (c[0] as ActionCommand).kind === "jbrowser.act").length;
  for (const [name, input, asks] of [
    ["params.key Enter при params.combo Tab", { intent: "key", params: { key: "Enter", combo: "Tab" } }, true],
    ["плоское key:'Tab' (до клиента params не доходит → Enter)", { intent: "key", key: "Tab" }, true],
    ["params без key — Enter по умолчанию", { intent: "key", params: {} }, true],
    ["params.key Tab", { intent: "key", params: { key: "Tab" } }, false],
  ] as const) {
    it(`${name} → ${asks ? "вопрос владельцу" : "без вопроса"}`, async () => {
      const { ctx, confirm, sendAction } = setup(undefined, false);
      await dispatchTool("web_open", { url: TG }, ctx);
      await dispatchTool("web_act", input, ctx);
      expect(confirm).toHaveBeenCalledTimes(asks ? 1 : 0);
      expect(jbActs(sendAction)).toBe(asks ? 0 : 1);
    });
  }
});

describe("srv-bypass-6 / srv-tests-6: слова коммита — данные", () => {
  it("заказ, покупка, комментарий, очистка корзины/папки, альтернативы «в корзину» — коммит", () => {
    for (const s of ["Place order", "Place your order", "Purchase", "Complete purchase", "Complete order", "Order now", "Buy now", "Comment", "Post comment",
      "Оставить комментарий", "Опубликовать комментарий", "Empty Trash now", "Empty the trash", "Очистить корзину", "Очистить папку",
      "Move to bin", "Move to the trash", "Перенести в корзину", "Перенесите в корзину"]) expect(COMMIT_WORDS_RE.test(s), s).toBe(true);
  });
  it("«Добавить в корзину», «Корзина», «Comments», «Комментарии», «Очистить», «Order history» — не коммит", () => {
    for (const s of ["Добавить в корзину", "Корзина", "Comments", "Комментарии", "Очистить", "Order history"]) expect(COMMIT_WORDS_RE.test(s), s).toBe(false);
  });
  it("клик «Оставить комментарий» на youtube.com — вопрос до клика", async () => {
    const { ctx, confirm, tabAct } = setup(undefined, false);
    await dispatchTool("browser_act", { url: "https://www.youtube.com/watch?v=x", intent: "click", text: "Оставить комментарий" }, ctx);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(tabAct).not.toHaveBeenCalled();
  });
});

describe("srv-bypass-5: встряхивание в мессенджере — возможный Enter", () => {
  it("click «обновить…» и shake на web.telegram.org — риск «Enter — отправка»; вне мессенджера и без слова — нет", () => {
    expect(assessWebCommit({ host: "web.telegram.org", intent: "click", params: { text: "Обновить ленту" } })?.what).toMatch(/Enter/u);
    expect(assessWebCommit({ host: "web.telegram.org", intent: "shake", params: {} })?.what).toMatch(/Enter/u);
    expect(assessWebCommit({ host: "www.youtube.com", intent: "click", params: { text: "обновить" } })).toBeNull();
    expect(assessWebCommit({ host: "web.telegram.org", intent: "click", params: { text: "Настройки" } })).toBeNull();
  });
});
