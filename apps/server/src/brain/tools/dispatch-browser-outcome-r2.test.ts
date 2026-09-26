/**
 * Адверс-ревью W1, раунд 2 — зона «честность исходов» через настоящий dispatchTool. Фикстуры — РЕАЛЬНАЯ форма ответа
 * расширения: tab.batch = {ok, done, total, stoppedAt?, code?, error?, results:[{step, ok, intent, result|error}]}
 * (modules/batch-plan.js + tabBatch), ошибки tab.act — extReplyError с code (мост). Реверт-проверка: сломай → красный.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { extReplyError } from "./ext-errors.js";
import { canvasClickAllowed } from "./handlers/browser.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
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
const makeCtx = (e: Ext): ToolContext =>
  ({ session: { sendAction: vi.fn<Send>(async () => ({ commandId: "c", ok: true, durationMs: 1 })) }, userId: "u1", ext: e, confirm: vi.fn(async () => ({ approved: true, outcome: "approved" as const })) }) as unknown as ToolContext;
const SITE = "https://shop.example/";
const text = (r: { content: unknown }): string => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
const STEPS = [
  { ref: "e1_1", intent: "type", params: { text: "кот" } },
  { ref: "e1_2", intent: "click" },
];
const typed = { step: 0, ok: true, intent: "type", result: { ok: true, value: "кот", submitted: false } };
const batch = (reply: unknown) => dispatchTool("browser_batch", { url: SITE, steps: STEPS }, makeCtx(ext({ tabBatch: vi.fn(async () => reply) })));

describe("srv-tests-5 / EXT-6: исход ПОСЛЕДНЕГО шага из results берста", () => {
  it("последний клик увёл страницу, исход не подтверждён (uncertain) — НЕ ЗНАЮ, не «Берст выполнен»", async () => {
    const last = { step: 1, ok: true, intent: "click", result: { ok: true, navigated: "https://shop.example/checkout", uncertain: true, note: "страница перешла во время действия — исход не подтверждён" } };
    const r = await batch({ ok: true, done: 2, total: 2, results: [typed, last] });
    expect(r.uncertain).toBe(true);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/НЕ ЗНАЮ/u);
    expect(text(r)).not.toMatch(/Берст выполнен/u);
    // журнал: шаг 1 сделан, действие шага 2 ушло с неизвестным исходом (не «сделано» и не «ошибка»)
    expect([r.partialSteps, r.partialInjected]).toEqual([1, true]);
  });

  it("последний шаг достоверно перешёл (navigated без uncertain) — выполнен, с пометкой о переходе, без uncertain", async () => {
    const last = { step: 1, ok: true, intent: "click", result: { ok: true, navigated: "https://shop.example/item/1" } };
    const r = await batch({ ok: true, done: 2, total: 2, results: [typed, last] });
    expect(r.isError).toBe(false);
    expect(r.uncertain).toBeUndefined();
    expect(text(r)).toMatch(/Берст выполнен: 2 из 2/u);
    expect(text(r)).toMatch(/увёл страницу/u);
  });
});

describe("ext-regress-3 / NEW-2 и submit-nav: стоп берста с известным исходом шага — не «не знаю»", () => {
  const stop = (code: string, why: string) => ({
    ok: false, code, stoppedAt: 0, done: 1, total: 2, results: [{ step: 0, ok: true, intent: "type", result: { ok: true, value: "кот", submitted: code === "submitted", ...(code === "navigated" ? { navigated: "https://shop.example/#list" } : {}) } }],
    error: `${code}: шаг 1 («type») — ${why}; остальные шаги НЕ выполнены. Сверь страницу (browser_inspect), вслепую не повторяй`,
  });

  it("navigated: «шаг 1 выполнен, страница перешла; остальные не делал — пересними», без uncertain", async () => {
    const r = await batch(stop("navigated", "выполнен, страница перешла на другой адрес"));
    expect(r.uncertain).toBeUndefined();
    expect(text(r)).toMatch(/шаг 1 выполнен, страница перешла/u);
    expect(text(r)).toMatch(/остальные шаги НЕ делал — пересними/u);
    expect(text(r)).not.toMatch(/НЕ ЗНАЮ/u);
    expect([r.partialSteps, r.partialInjected]).toEqual([1, undefined]);
  });

  it("submitted: «на шаге 1 форма отправлена, остальное не делал», без uncertain", async () => {
    const r = await batch(stop("submitted", "выполнен, форма отправлена (страница могла уйти)"));
    expect(r.uncertain).toBeUndefined();
    expect(text(r)).toMatch(/на шаге 1 форма отправлена/u);
    expect(text(r)).not.toMatch(/НЕ ЗНАЮ/u);
    expect(r.partialSteps).toBe(1);
  });

  it("uncertain-стоп: исход шага неизвестен — НЕ ЗНАЮ; в журнал он не «сделан», а «ушёл, сверь»", async () => {
    const first = { step: 0, ok: true, intent: "type", result: { ok: true, navigated: "https://shop.example/pay", uncertain: true } };
    const r = await batch({ ok: false, code: "uncertain", stoppedAt: 0, done: 1, total: 2, results: [first], error: "uncertain: шаг 1 («type») — исход не подтверждён (страница перешла во время действия); остальные шаги НЕ выполнены" });
    expect(r.uncertain).toBe(true);
    expect(text(r)).toMatch(/НЕ ЗНАЮ/u);
    expect([r.partialSteps, r.partialInjected]).toEqual([undefined, true]);
  });
});

describe("B-16: loading:true от расширения доходит до модели (read/inspect/act/batch), act — не observed", () => {
  const LOADING = /Страница ещё грузилась/u;
  // Наша пометка — ВНЕ <untrusted_content> (после закрывающего тега), иначе модель читала бы её как текст страницы.
  const outside = (r: { content: unknown }): string => text(r).split("</untrusted_content>").pop() ?? "";

  it("browser_read и browser_inspect: пометка «ещё грузилась» после untrusted-блока; без loading — её нет", async () => {
    const e = ext({
      tabRead: vi.fn(async () => ({ title: "Магазин", url: SITE, text: "Загрузка…", headings: [], loading: true })),
      tabInspect: vi.fn(async () => ({ url: SITE, title: "Магазин", count: 0, truncated: false, frames: [], elements: [], loading: true })),
    });
    const read = await dispatchTool("browser_read", { tabId: 5 }, makeCtx(e));
    const insp = await dispatchTool("browser_inspect", { tabId: 5 }, makeCtx(e));
    expect(outside(read)).toMatch(LOADING);
    expect(outside(insp)).toMatch(LOADING);
    const calm = ext({ tabRead: vi.fn(async () => ({ title: "Магазин", url: SITE, text: "Каталог", headings: [] })) });
    expect(text(await dispatchTool("browser_read", { tabId: 5 }, makeCtx(calm)))).not.toMatch(LOADING);
  });

  it("browser_act set с readback на недогруженной странице — пометка и НЕ observed (с загруженной — observed)", async () => {
    const reply = { ok: true, value: "Иванов", changed: true };
    const slow = await dispatchTool("browser_act", { tabId: 5, intent: "set", ref: "e1_3", value: "Иванов" }, makeCtx(ext({ tabAct: vi.fn(async () => ({ ...reply, loading: true })) })));
    const fast = await dispatchTool("browser_act", { tabId: 5, intent: "set", ref: "e1_3", value: "Иванов" }, makeCtx(ext({ tabAct: vi.fn(async () => reply) })));
    expect(text(slow)).toMatch(LOADING);
    expect(slow.observed).toBeUndefined();
    expect(fast.observed).toBe(true);
  });

  it("browser_batch: шаг на недогруженной странице — пометка к «Берст выполнен»", async () => {
    const r = await batch({ ok: true, done: 2, total: 2, results: [{ ...typed, result: { ...typed.result, loading: true } }, { step: 1, ok: true, intent: "click", result: { ok: true } }] });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(LOADING);
  });
});

describe("EXT-9 остаток: scroll по ref без сдвига — честное «край», не «кнопка не та» и не координаты", () => {
  it("no_effect у scroll → текст про прокрутку, без хатча", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("no_effect: прокрутка ничего не сдвинула — ни контейнер цели, ни страница дальше не прокручиваются (край)", "no_effect"); }) });
    const ctx = makeCtx(e);
    const r = await dispatchTool("browser_act", { tabId: 5, intent: "scroll", ref: "e1_4", dy: 300 }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^browser_act «scroll»: прокрутка ничего не сдвинула/u);
    expect(text(r)).not.toMatch(/кнопка не та/u);
    expect(canvasClickAllowed(ctx)).toBe(false);
  });
});

describe("srv-regress-4: фрейм пропал ДО действия — «не выполнял», не «не знаю»", () => {
  // Ровно то, что шлёт мост: tab.act → {ok:false, error:"frame_missing: …", code:"frame_missing"} → extReplyError.
  const missing = () => extReplyError("frame_missing: целевой фрейм 7 пропал ДО действия — ничего не выполнял. Сделай свежий browser_inspect и повтори по новому снимку.", "frame_missing");

  it("browser_act: честный провал без uncertain и без координатного хатча", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw missing(); }) });
    const ctx = makeCtx(e);
    const r = await dispatchTool("browser_act", { tabId: 5, intent: "click", ref: "f7e1_2" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBeUndefined();
    expect(text(r)).toMatch(/^browser_act «click»: целевой фрейм пропал ДО действия — ничего не выполнял/u);
    expect(text(r)).not.toMatch(/НЕ ЗНАЮ|canvas/u);
    expect(canvasClickAllowed(ctx)).toBe(false); // элемент был — координатный хатч не открываем
  });

  it("а посреди действия (frame_gone) — по-прежнему «НЕ ЗНАЮ» (uncertain)", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("frame_gone: целевой фрейм 7 исчез", "frame_gone"); }) });
    const r = await dispatchTool("browser_act", { url: SITE, intent: "click", ref: "f7e1_2" }, makeCtx(e));
    expect(r.uncertain).toBe(true);
  });

  it("берст: шаг упал frame_missing — «шаг не выполнен», без uncertain и без «ушло» в журнал", async () => {
    const r = await batch({ ok: false, stoppedAt: 0, done: 0, total: 2, code: "frame_missing", results: [{ step: 0, ok: false, intent: "type", error: "frame_missing: целевой фрейм 7 пропал ДО действия — ничего не выполнял." }], error: "шаг 1 («type») не выполнен: frame_missing: целевой фрейм 7 пропал ДО действия — ничего не выполнял." });
    expect(r.uncertain).toBeUndefined();
    expect(r.partialInjected).toBeUndefined();
    expect(text(r)).toMatch(/шаг не выполнен/u);
  });
});

describe("invalid_combo: страница не поняла сочетание — честный отказ, без координатного хатча", () => {
  it("browser_act key «a+Enter»: «ничего не нажимал», хатч закрыт, без uncertain", async () => {
    const e = ext({ tabAct: vi.fn(async () => { throw extReplyError("invalid_combo: key: не понял клавишу «a+Enter» — ничего не нажимал", "invalid_combo"); }) });
    const ctx = makeCtx(e);
    const r = await dispatchTool("browser_act", { tabId: 5, intent: "key", ref: "e1", combo: "a+Enter" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.uncertain).toBeUndefined();
    expect(text(r)).toMatch(/сочетание клавиш не распознано — ничего не нажимал/u);
    expect(canvasClickAllowed(ctx)).toBe(false);
  });
});
