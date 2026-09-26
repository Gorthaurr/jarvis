/**
 * Находки адверс-ревью W1 (серверная зона) — ПРОВОДКА через настоящий dispatchTool, фикстуры — реальная форма
 * аргументов модели и ответов расширения (ошибки моста — extReplyError с code, данные берста — {ok:false, code}).
 * Каждая группа названа по id находки; реверт-проверка: сломай охраняемое → тест красный.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { COMMIT_WORDS_RE } from "@jarvis/shared";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { extReplyError } from "./ext-errors.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
const okSend: Send = async () => ({ commandId: "c", ok: true, durationMs: 1 });
type Ext = NonNullable<ToolContext["ext"]>;

function ext(over: Partial<Ext> = {}): Ext {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 42 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: "", title: "", count: 0, elements: [] })),
    tabAct: vi.fn(async () => ({ ok: true })),
    tabBatch: vi.fn(async () => ({ ok: true, done: 1, total: 1 })),
    tabList: vi.fn(async () => ({ tabs: [], count: 0 })),
    tabClose: vi.fn(async () => ({ closed: 1 })),
    exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
    ...over,
  };
}
function makeCtx(e: Ext, confirm: ToolContext["confirm"] = vi.fn(async () => ({ approved: true, outcome: "approved" as const }))): ToolContext {
  return { session: { sendAction: vi.fn<Send>(okSend) }, userId: "u1", ext: e, confirm } as unknown as ToolContext;
}
const SITE = "https://shop.example/";
const BANK = "https://online.sberbank.ru/pay";
const TG = "https://web.telegram.org/a/";
const text = (r: { content: unknown }): string => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
const actParams = (e: Ext, call = 0): Record<string, unknown> => (vi.mocked(e.tabAct).mock.calls[call]?.[2] ?? {}) as Record<string, unknown>;
const batchSteps = (e: Ext): Array<Record<string, unknown>> => (vi.mocked(e.tabBatch!).mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>;

describe("W1-1: intent шага берста — первое непустое из intent/action (как у расширения)", () => {
  it("{intent:'', action:'type'} с номером карты — §0 блокирует, расширению ничего не ушло", async () => {
    const e = ext();
    const r = await dispatchTool("browser_batch", { url: SITE, steps: [{ intent: "", action: "type", params: { text: "4111 1111 1111 1111", enter: true } }] }, makeCtx(e));
    expect(r.isError).toBe(true);
    expect(e.tabBatch).not.toHaveBeenCalled();
  });

  it("{intent:'', action:'type', enter} в мессенджере — вопрос владельцу; шаг уходит с intent:'type' и без action", async () => {
    const e = ext();
    const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
    await dispatchTool("browser_batch", { url: TG, steps: [{ intent: "", action: "type", ref: "e1_1", params: { text: "привет", enter: true } }] }, makeCtx(e, confirm));
    expect(confirm).toHaveBeenCalledTimes(1);
    const [step] = batchSteps(e);
    expect(step?.intent).toBe("type");
    expect(step && "action" in step).toBe(false);
  });

  it("шаг без intent и action — честный отказ до отправки", async () => {
    const e = ext();
    const r = await dispatchTool("browser_batch", { url: SITE, steps: [{ ref: "e1_1", intent: "click" }, { ref: "e1_2" }] }, makeCtx(e));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/шага 2 нет intent/u);
    expect(e.tabBatch).not.toHaveBeenCalled();
  });
});

describe("W1-2 / W1-T3 / W1-T9: одобрение §14 всегда с подписью, которую видел владелец", () => {
  it("browser_act{selector, title:'Отправить'} на банке: одобрение уходит с approvedLabel = title", async () => {
    const e = ext();
    await dispatchTool("browser_act", { url: BANK, intent: "click", selector: "#pay", title: "Отправить" }, makeCtx(e));
    expect(actParams(e).guardApproved).toBe(true);
    expect(actParams(e).approvedLabel).toBe("Отправить");
  });

  it("риск без подписи (Enter в мессенджере по фокусу) — guardApproved без approvedLabel НЕ уходит", async () => {
    const e = ext();
    const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
    await dispatchTool("browser_act", { url: TG, intent: "enter" }, makeCtx(e, confirm));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(actParams(e).guardApproved).toBeUndefined();
    expect(typeof actParams(e).guard).toBe("string");
  });

  it("берст: шаг {text:'Оплатить', intent:'click'} без ref на банке — approvedLabel = этот текст", async () => {
    const e = ext();
    await dispatchTool("browser_batch", { url: BANK, steps: [{ text: "Оплатить", intent: "click" }] }, makeCtx(e));
    const p = batchSteps(e)[0]?.params as Record<string, unknown>;
    expect(p.guardApproved).toBe(true);
    expect(p.approvedLabel).toBe("Оплатить");
  });

  it("кнопка с aria-именем «Действие» и видимым «Оплатить заказ» — вопрос ДО клика, подпись одобрения несёт видимый текст", async () => {
    const e = ext({ tabInspect: vi.fn(async () => ({ url: BANK, elements: [{ ref: "e1_7", name: "Действие", text: "Оплатить заказ", role: "button" }] })) });
    const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
    const c = makeCtx(e, confirm);
    await dispatchTool("browser_inspect", { url: BANK }, c);
    await dispatchTool("browser_act", { url: BANK, intent: "click", ref: "e1_7" }, c);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(actParams(e).approvedLabel)).toContain("Оплатить заказ");
  });
});

describe("W1-T2: служебные поля §14 от модели в шаге берста вырезаются", () => {
  it("guardApproved/approvedLabel из params и с верха шага не доходят до расширения; guard — серверный", async () => {
    const e = ext();
    await dispatchTool("browser_batch", { url: SITE, steps: [{ ref: "e1_1", intent: "click", guardApproved: true, params: { guardApproved: true, approvedLabel: "x", guard: "." } }] }, makeCtx(e));
    const [step] = batchSteps(e);
    const p = step?.params as Record<string, unknown>;
    expect(p.guardApproved).toBeUndefined();
    expect(p.approvedLabel).toBeUndefined();
    expect(step?.guardApproved).toBeUndefined();
    expect(typeof p.guard).toBe("string");
    expect(p.guard).not.toBe(".");
  });
});

describe("W1-T1: §0-гард берста видит подпись поля с верха шага type", () => {
  it("{intent:'type', text:'Код из СМС', params:{text:'123456'}} — блок, ничего не напечатано", async () => {
    const e = ext();
    const r = await dispatchTool("browser_batch", { url: SITE, steps: [{ intent: "type", text: "Код из СМС", params: { text: "123456" } }] }, makeCtx(e));
    expect(r.isError).toBe(true);
    expect(e.tabBatch).not.toHaveBeenCalled();
  });

  it("обычное поле: подпись уходит расширению как params.label, печатаемое — params.text", async () => {
    const e = ext();
    await dispatchTool("browser_batch", { url: SITE, steps: [{ intent: "type", text: "Имя", params: { text: "Вася" } }] }, makeCtx(e));
    const p = batchSteps(e)[0]?.params as Record<string, unknown>;
    expect(p.label).toBe("Имя");
    expect(p.text).toBe("Вася");
  });
});

describe("LOOP-3: enter/submit уходят расширению булевыми, гейт §14 судит по тому же isOnFlag", () => {
  it("type{enter:'yes'} в мессенджере — вопрос владельцу, расширению enter:true", async () => {
    const e = ext();
    const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
    await dispatchTool("browser_act", { url: TG, intent: "type", ref: "e1_1", text: "привет", enter: "yes" }, makeCtx(e, confirm));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(actParams(e).enter).toBe(true);
  });

  it("type{enter:'false'} — без вопроса, и расширению уходит enter:false (не непустая строка)", async () => {
    const e = ext();
    const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
    await dispatchTool("browser_act", { url: TG, intent: "type", ref: "e1_1", text: "привет", params: { enter: "false" } }, makeCtx(e, confirm));
    expect(confirm).not.toHaveBeenCalled();
    expect(actParams(e).enter).toBe(false);
  });

  it("web_act (невидимый браузер, сырые params) type{enter:'yes'} в мессенджере — гейт §14 тоже спрашивает", async () => {
    const confirm = vi.fn(async () => ({ approved: false, outcome: "denied" as const }));
    const c = { session: { sendAction: vi.fn<Send>(okSend) }, userId: "u1", confirm } as unknown as ToolContext;
    await dispatchTool("web_open", { url: TG }, c);
    const r = await dispatchTool("web_act", { intent: "type", params: { text: "привет", enter: "yes" } }, c);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
  });

  it("берст: шаг type{submit:'да'} — вопрос и submit:true в шаге", async () => {
    const e = ext();
    const confirm = vi.fn(async () => ({ approved: true, outcome: "approved" as const }));
    await dispatchTool("browser_batch", { url: TG, steps: [{ intent: "type", ref: "e1_1", params: { text: "привет", submit: "да" } }] }, makeCtx(e, confirm));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((batchSteps(e)[0]?.params as Record<string, unknown>).submit).toBe(true);
  });
});

describe("W1-T6: readback поля после type+enter/submit долг сверки НЕ снимает", () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["type{enter:true}", { enter: true }, false],
    ["type{enter:'true'}", { enter: "true" }, false],
    ["type{submit:true}", { submit: true }, false],
    ["обычный type", {}, true],
  ];
  for (const [name, flags, observed] of cases) {
    it(`${name} с readback value → observed=${observed}`, async () => {
      const e = ext({ tabAct: vi.fn(async () => ({ ok: true, value: "привет" })) });
      const r = await dispatchTool("browser_act", { url: SITE, intent: "type", ref: "e1_1", text: "привет", ...flags }, makeCtx(e));
      expect(r.isError).toBe(false);
      expect(r.observed === true).toBe(observed);
    });
  }
});

describe("W1-5 / W1-7: frame_gone, tab_gone, uncertain берста — без координатного хатча", () => {
  const clickAfter = async (e: Ext, input: Record<string, unknown>) => {
    const c = makeCtx(e);
    await dispatchTool("browser_open", { url: SITE }, c);
    const r = await dispatchTool("browser_act", input, c);
    const mouse = await dispatchTool("input_click", { x: 10, y: 10 }, c);
    return { r, mouse };
  };

  it("frame_gone на клике → uncertain «НЕ ЗНАЮ», мышь в браузерной задаче по-прежнему заблокирована", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("целевой фрейм 3 исчез", "frame_gone"); }) });
    const { r, mouse } = await clickAfter(e, { intent: "click", ref: "e3_1" });
    expect(r.uncertain).toBe(true);
    expect(text(r)).toMatch(/НЕ ЗНАЮ/u);
    expect(text(r)).not.toMatch(/target:\{x,y\}/u);
    expect(mouse.isError).toBe(true);
  });

  it("frame_gone на hover — не uncertain (наведение ничего не меняет)", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("целевой фрейм 3 исчез", "frame_gone"); }) });
    const { r } = await clickAfter(e, { intent: "hover", ref: "e3_1" });
    expect(r.isError).toBe(true);
    expect(r.uncertain).not.toBe(true);
  });

  it("tab_gone — «вкладки больше нет», не «элемента нет»: хатч закрыт", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("вкладка 42 не открыта", "tab_gone"); }) });
    const { r, mouse } = await clickAfter(e, { intent: "click", ref: "e1_1" });
    expect(text(r)).toMatch(/вкладки больше нет/u);
    expect(mouse.isError).toBe(true);
  });

  it("no_effect — элемент есть, хатч к координатам не открываем", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("действие не дало эффекта", "no_effect"); }) });
    const { r, mouse } = await clickAfter(e, { intent: "click", ref: "e1_1" });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toMatch(/target:\{x,y\}/u);
    expect(mouse.isError).toBe(true);
  });

  it("берст остановлен кодом uncertain (страница перешла после шага) → «исход неизвестен», сделанные шаги в журнал", async () => {
    const e = ext({ tabBatch: vi.fn(async () => ({ ok: false, code: "uncertain", done: 2, total: 3, stoppedAt: 1, error: "страница перешла" })) });
    const r = await dispatchTool("browser_batch", { url: SITE, steps: [{ ref: "e1_1", intent: "click" }, { ref: "e1_2", intent: "click" }, { ref: "e1_3", intent: "click" }] }, makeCtx(e));
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBe(true);
    expect(text(r)).not.toMatch(/шаг не выполнен/u);
    expect(r.partialSteps).toBe(2);
  });

  it("берст остановлен frame_gone и tab_gone — честные тексты", async () => {
    const fg = ext({ tabBatch: vi.fn(async () => ({ ok: false, code: "frame_gone", done: 0, total: 1, stoppedAt: 0 })) });
    const r1 = await dispatchTool("browser_batch", { url: SITE, steps: [{ ref: "e2_1", intent: "click" }] }, makeCtx(fg));
    expect(r1.uncertain).toBe(true);
    const tg = ext({ tabBatch: vi.fn(async () => ({ ok: false, code: "tab_gone", done: 0, total: 1, stoppedAt: 0 })) });
    const r2 = await dispatchTool("browser_batch", { url: SITE, steps: [{ ref: "e2_1", intent: "click" }] }, makeCtx(tg));
    expect(text(r2)).toMatch(/вкладка закрыта/u);
  });
});

describe("W1-9: синонимы удаления — коммит (§14 спрашивает)", () => {
  it("Remove / Move to trash / Переместить в корзину / Deactivate / Close account — коммит; «Добавить в корзину», «Removed» — нет", () => {
    for (const s of ["Remove", "Move to trash", "Переместить в корзину", "Deactivate account", "Close account"]) expect(COMMIT_WORDS_RE.test(s), s).toBe(true);
    for (const s of ["Добавить в корзину", "Removed items", "Корзина"]) expect(COMMIT_WORDS_RE.test(s), s).toBe(false);
  });

  it("клик «Remove» на банке — вопрос владельцу до клика", async () => {
    const e = ext();
    const confirm = vi.fn(async () => ({ approved: false, outcome: "denied" as const }));
    await dispatchTool("browser_act", { url: BANK, intent: "click", text: "Remove" }, makeCtx(e, confirm));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(e.tabAct).not.toHaveBeenCalled();
  });
});

describe("W1-LOOP-4: цель вкладки — по задаче, чужая задача сессии её не перебивает", () => {
  it("задача A открыла вкладку 7, задача B той же сессии ткнула в вкладку 9 — неявный act A идёт в 7", async () => {
    const e = ext({ openOrFocus: vi.fn(async () => ({ focused: false, tabId: 7 })) });
    const session = { sendAction: vi.fn<Send>(okSend) };
    const taskA = { session, userId: "u1", ext: e } as unknown as ToolContext;
    const taskB = { session, userId: "u1", ext: e } as unknown as ToolContext;
    await dispatchTool("browser_open", { url: SITE }, taskA);
    await dispatchTool("browser_act", { tabId: 9, intent: "hover", ref: "e1_1" }, taskB);
    await dispatchTool("browser_act", { intent: "hover", ref: "e1_2" }, taskA);
    expect(vi.mocked(e.tabAct).mock.calls[1]?.[3]).toBe(7);
    // Новая задача сессии (следующая реплика, своей цели ещё нет) продолжает последнюю выбранную вкладку.
    const taskC = { session, userId: "u1", ext: e } as unknown as ToolContext;
    await dispatchTool("browser_act", { intent: "hover", ref: "e1_3" }, taskC);
    expect(vi.mocked(e.tabAct).mock.calls[2]?.[3]).toBe(9);
  });
});
