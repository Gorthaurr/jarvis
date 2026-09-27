/**
 * W1-D6 и текст вопроса §14 (стенд): суд о коммите по ref и подпись в вопросе владельцу — только ВИДИМЫЕ подписи
 * элемента (имя/текст/label/aria), не селектор/роль/тип. Раньше подпись ref склеивалась с селектором и типом:
 *  • кнопка навигации теста Moodle `input[type="submit"][name="next"]` «Следующая страница» судилась СДАЧЕЙ (слово
 *    submit из селектора и типа) — вопрос владельцу на каждой странице теста;
 *  • вопрос про оплату показывал CSS: «клик «Оплатить #payform > button:nth-of-type(1) button» на online.sberbank.ru».
 * Снимки ниже — ровно те, что отдало расширение на стенде (infra/bench, browser_inspect).
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
type Ext = NonNullable<ToolContext["ext"]>;

const LMS = "https://lms.vuz-bench.ru/mod/quiz/attempt.php?attempt=100&page=0";
const SUMMARY = "https://lms.vuz-bench.ru/mod/quiz/summary.php?attempt=100";
const BANK = "https://online.sberbank.ru/?run=r1";
const NEXT = { name: "Следующая страница", ref: "e29133_3", role: "input", selector: 'input[type="submit"][name="next"]', state: {}, tag: "input", type: "submit", idx: 3 };
const PAY = { name: "Оплатить", ref: "e82950_0", role: "button", selector: "#payform > button:nth-of-type(1)", state: {}, tag: "button", idx: 0 };
const FINISH = { name: "Отправить всё и завершить тест", ref: "e7_4", role: "button", selector: "#single_button_fin", state: {}, tag: "button", idx: 4 };
const SEND = { name: "Отправить", ref: "e3_1", role: "button", selector: "button.submit", state: {}, tag: "button", idx: 1 };

function wire(url: string, element: Record<string, unknown>) {
  const tabAct = vi.fn(async (_url?: string, _intent?: string, _params?: Record<string, unknown>, _tabId?: number) => ({ ok: true, changed: true }));
  const tabBatch = vi.fn(async () => ({ ok: true, done: 1, total: 1 }));
  const ext: Ext = {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 5 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url, title: "t", count: 1, gen: 1, elements: [element] })),
    tabAct,
    tabBatch,
    tabList: vi.fn(async () => ({ tabs: [{ tabId: 5, url, status: "complete", active: true }], count: 1 })),
    tabClose: vi.fn(async () => ({ closed: 1 })),
    exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
  };
  const confirm = vi.fn(async (_summary: string) => ({ approved: true, outcome: "approved" as const }));
  const ctx = { session: { sendAction: vi.fn<Send>(async () => ({ commandId: "c", ok: true, durationMs: 1 })) }, userId: "u1", ext, confirm } as unknown as ToolContext;
  const click = async () => {
    await dispatchTool("browser_inspect", { url, tabId: 5 }, ctx);
    return dispatchTool("browser_act", { url, tabId: 5, intent: "click", ref: element.ref }, ctx);
  };
  return { ctx, confirm, tabAct, tabBatch, click };
}

describe("W1-D6: навигация теста Moodle по ref — без вопроса владельцу", () => {
  it("«Следующая страница» (input[type=submit][name=next]) — клик уходит, вопроса нет, гард странице уходит", async () => {
    const w = wire(LMS, NEXT);
    const r = await w.click();
    expect(r.isError, String(r.content)).toBe(false);
    expect(w.confirm).not.toHaveBeenCalled();
    const params = w.tabAct.mock.calls[0]?.[2] ?? {};
    expect(typeof params.guard).toBe("string"); // подпись реального элемента всё равно судит страница
    expect(params.guardApproved).toBeUndefined();
  });

  it("то же шагом берста — без вопроса", async () => {
    const w = wire(LMS, NEXT);
    await dispatchTool("browser_inspect", { url: LMS, tabId: 5 }, w.ctx);
    const r = await dispatchTool("browser_batch", { url: LMS, tabId: 5, steps: [{ intent: "click", ref: NEXT.ref }] }, w.ctx);
    expect(r.isError, String(r.content)).toBe(false);
    expect(w.confirm).not.toHaveBeenCalled();
  });
});

describe("§14 не ослаблен: видимые подписи-коммиты по ref по-прежнему спрашивают", () => {
  for (const [name, url, el] of [["«Отправить всё и завершить тест» (Moodle)", SUMMARY, FINISH], ["«Оплатить» (банк)", BANK, PAY], ["«Отправить» (банк)", BANK, SEND]] as const) {
    it(`${name} — ровно один вопрос`, async () => {
      const w = wire(url, el);
      await w.click();
      expect(w.confirm).toHaveBeenCalledTimes(1);
    });
  }
});

describe("вопрос владельцу — видимая подпись, без CSS-селектора и роли", () => {
  it("«Оплатить» на банке: в вопросе «Оплатить», нет #payform/nth-of-type/button", async () => {
    const w = wire(BANK, PAY);
    await w.click();
    const q = String(w.confirm.mock.calls[0]?.[0]);
    expect(q).toMatch(/клик «Оплатить» на online\.sberbank\.ru/u);
    expect(q).not.toMatch(/#payform|nth-of-type|button/u);
  });

  it("text модели совпал с именем из снимка — подпись один раз, не «Оплатить Оплатить»", async () => {
    const w = wire(BANK, PAY);
    await dispatchTool("browser_inspect", { url: BANK, tabId: 5 }, w.ctx);
    await dispatchTool("browser_act", { url: BANK, tabId: 5, intent: "click", ref: PAY.ref, text: "Оплатить" }, w.ctx);
    expect(String(w.confirm.mock.calls[0]?.[0])).toMatch(/клик «Оплатить» на/u);
  });

  it("берст с «Оплатить» по ref — в перечне шагов видимая подпись, без селектора", async () => {
    const w = wire(BANK, PAY);
    await dispatchTool("browser_inspect", { url: BANK, tabId: 5 }, w.ctx);
    await dispatchTool("browser_batch", { url: BANK, tabId: 5, steps: [{ intent: "click", ref: PAY.ref }] }, w.ctx);
    const q = String(w.confirm.mock.calls[0]?.[0]);
    expect(q).toMatch(/клик «Оплатить»/u);
    expect(q).not.toMatch(/#payform|nth-of-type/u);
  });
});
