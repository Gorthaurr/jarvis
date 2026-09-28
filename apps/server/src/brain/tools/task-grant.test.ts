/**
 * «Поручение = разрешение» для учебных систем (28.09): реплика владельца «пройди тест/курс» выдаёт грант на LMS-коммиты
 * (старт попытки, проверка, сдача) — вопрос §14 на них не задаётся. Остальное §14 (банк, мессенджер, магазин) — как было.
 * Часть 1 — политика выдачи; часть 2 — проводка через настоящий dispatchTool; часть 3 — ПЕТЛЁЙ (handleUserText).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { Session } from "../../gateway/session.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { type AgentDeps, handleUserText } from "../agent/index.js";
import { TaskManager } from "../tasks/manager.js";
import { dispatchTool, type ToolContext } from "./dispatch.js";
import { fakeClient } from "./test-support/fake-client.js";
import { EDU_GRANT_MS, eduGrantActive, eduGrantedAt, eduGrantedFor, noteOwnerTurn, resetTaskGrants } from "./task-grant.js";

const U = "u1";
const say = (text: string, addressed = true, now?: number): void => noteOwnerTurn(U, text, { addressed, ...(now !== undefined ? { now } : {}) });

beforeEach(resetTaskGrants);
afterEach(resetTaskGrants);

describe("выдача гранта: только реплика владельца с учебным поручением", () => {
  it.each([
    "Джарвис, пройди все мини-тесты во всех курсах.",
    "В гражданском процессе пройдет все мини-курсы.", // STT: «пройдет»
    "Джарвис, в м с пройди все курсы по всем. Типа урокам.",
    "сдай тест по математике",
    "все тесты пройди",
  ])("«%s» — выдаёт", (t) => {
    say(t);
    expect(eduGrantActive(U)).toBe(true);
  });

  it.each([
    "Джарвис, ты меня слышишь?",
    "Прием.",
    "Джарвис, в м с зайди.",
    "открой хром и ютуб",
    "какой сегодня курс доллара",
    "реши уравнение",
    "данные",
  ])("«%s» — не выдаёт", (t) => {
    say(t);
    expect(eduGrantActive(U)).toBe(false);
  });

  it("реплика без «Джарвис» (фон, ТВ) и машинный реэнтри не выдают", () => {
    say("пройди все тесты", false);
    expect(eduGrantActive(U)).toBe(false);
  });

  it("«иди/давай/да» продлевает уже выданный грант, но сам его не выдаёт", () => {
    say("иди");
    expect(eduGrantActive(U)).toBe(false);
    say("пройди все тесты", true, 1_000);
    say("Джарвис, иди.", true, 1_000 + EDU_GRANT_MS - 10);
    expect(eduGrantActive(U, 1_000 + EDU_GRANT_MS + 5)).toBe(true); // без продления кончился бы
    expect(eduGrantActive(U, 1_000 + 2 * EDU_GRANT_MS)).toBe(false);
  });

  it("посторонняя реплика грант не продлевает; «данные» — не «да»", () => {
    say("пройди все тесты", true, 1_000);
    say("какая погода", true, 1_000 + EDU_GRANT_MS - 10);
    say("данные", true, 1_000 + EDU_GRANT_MS - 10);
    expect(eduGrantActive(U, 1_000 + EDU_GRANT_MS + 5)).toBe(false);
  });

  it.each(["стоп", "Джарвис, хватит", "отмена", "не сдавай пока", "не надо"])("«%s» — снимает грант", (t) => {
    say("пройди все тесты");
    say(t);
    expect(eduGrantActive(U)).toBe(false);
  });

  it("грант чужого userId не действует", () => {
    say("пройди все тесты");
    expect(eduGrantActive("other")).toBe(false);
  });
});

describe("где действует: только учебная страница на не-опасном хосте", () => {
  beforeEach(() => say("пройди все тесты"));
  it("LMS по пути — да; обычный сайт — нет; опасный хост даже с LMS-подобным путём — нет", () => {
    expect(eduGrantedAt(U, { host: "eos.imes.su", url: "https://eos.imes.su/mod/quiz/view.php?id=5" })).toBe(true);
    expect(eduGrantedAt(U, { host: "shop.example", url: "https://shop.example/cart" })).toBe(false);
    expect(eduGrantedAt(U, { host: "online.sberbank.ru", url: "https://online.sberbank.ru/mod/quiz/view.php?id=5" })).toBe(false);
    expect(eduGrantedAt(U, { host: "", url: "" })).toBe(false);
  });
  it("GUI-гейт браузера: только категория edu", () => {
    expect(eduGrantedFor(U, "edu")).toBe(true);
    expect(eduGrantedFor(U, "messenger")).toBe(false);
    expect(eduGrantedFor(U, "unknown")).toBe(false);
    expect(eduGrantedFor(U, undefined)).toBe(false);
  });
});

// ---------- проводка: настоящий dispatchTool, форма моста как у настоящего расширения ----------
type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
const okSend: Send = async () => ({ commandId: "c", ok: true, durationMs: 1 });
type Tab = { tabId: number; url: string };
function ext(tab: Tab, tabAct = vi.fn(async (..._a: unknown[]) => ({ ok: true, changed: true })), tabBatch = vi.fn(async (..._a: unknown[]) => ({ ok: true, results: [] }))) {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: tab.tabId })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: "", title: "", count: 0, elements: [] })),
    tabAct,
    tabBatch,
    tabList: vi.fn(async () => ({ tabs: [{ status: "complete", active: true, ...tab }], count: 1 })),
    tabClose: vi.fn(async () => ({ closed: 1 })),
    exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
  };
}
function makeCtx(e: unknown, approved = false): ToolContext & { confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn(async () => ({ approved, outcome: approved ? "approved" : "denied" }));
  return { session: { sendAction: okSend }, userId: U, confirm, ext: e } as unknown as ToolContext & { confirm: ReturnType<typeof vi.fn> };
}
const act = (c: ToolContext, input: Record<string, unknown>) => dispatchTool("browser_act", input, c);
const VIEW = { tabId: 4, url: "https://eos.imes.su/mod/quiz/view.php?id=5" };
const SUMMARY = { tabId: 4, url: "https://eos.imes.su/mod/quiz/summary.php?attempt=42" };

describe("проводка через dispatchTool", () => {
  it("КОНТРОЛЬ без гранта: «Пройти тест» спрашивает, при отказе клика нет", async () => {
    const e = ext(VIEW);
    const c = makeCtx(e, false);
    await act(c, { tabId: 4, intent: "click", params: { text: "Пройти тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(e.tabAct).not.toHaveBeenCalled();
  });

  it("с грантом: «Пройти тест» — без вопроса, клик ушёл", async () => {
    say("Джарвис, пройди все мини-тесты");
    const e = ext(VIEW);
    const c = makeCtx(e, false);
    const r = await act(c, { tabId: 4, intent: "click", params: { text: "Пройти тест" } });
    expect(r.isError).toBeFalsy();
    expect(c.confirm).not.toHaveBeenCalled();
    expect(e.tabAct).toHaveBeenCalledTimes(1);
  });

  it("с грантом: страница вернула commit_confirm («Отправить всё и завершить тест») — повтор без вопроса", async () => {
    say("пройди все тесты");
    const tabAct = vi
      .fn()
      .mockRejectedValueOnce(new Error("tab.act click: commit_confirm: Отправить всё и завершить тест"))
      .mockResolvedValueOnce({ ok: true, changed: true });
    const e = ext(SUMMARY, tabAct);
    const c = makeCtx(e, false);
    const r = await act(c, { tabId: 4, intent: "click", params: { selector: "#finish" } });
    expect(r.isError).toBeFalsy();
    expect(c.confirm).not.toHaveBeenCalled();
    expect(tabAct).toHaveBeenCalledTimes(2);
    expect((tabAct.mock.calls[1]![2] as Record<string, unknown>).approvedLabel).toMatch(/Отправить всё/u);
  });

  it("с грантом: browser_batch с коммитом LMS — без вопроса", async () => {
    say("пройди все тесты");
    const e = ext(SUMMARY);
    const c = makeCtx(e, false);
    await dispatchTool("browser_batch", { tabId: 4, steps: [{ intent: "click", params: { text: "Отправить на проверку" } }] }, c);
    expect(c.confirm).not.toHaveBeenCalled();
    expect(e.tabBatch).toHaveBeenCalledTimes(1);
  });

  it("с грантом банк по-прежнему спрашивает: «пройди тест» не разрешает «Перевести»", async () => {
    say("пройди все тесты");
    const e = ext({ tabId: 7, url: "https://online.sberbank.ru/transfer" });
    const c = makeCtx(e, false);
    const r = await act(c, { tabId: 7, intent: "click", params: { text: "Перевести" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    expect(e.tabAct).not.toHaveBeenCalled();
  });

  it("с грантом мессенджер спрашивает про Enter; обычный магазин — «Оплатить» тоже", async () => {
    say("пройди все тесты");
    const wa = makeCtx(ext({ tabId: 8, url: "https://web.whatsapp.com/" }), false);
    await act(wa, { tabId: 8, intent: "key", params: { combo: "Enter" } });
    expect(wa.confirm).toHaveBeenCalledTimes(1);
    // Обычный магазин: подпись «Оплатить» судит страница (guard → commit_confirm) — грант LMS этот суд не отключает.
    const tabAct = vi
      .fn()
      .mockRejectedValueOnce(new Error("tab.act click: commit_confirm: Оплатить"))
      .mockResolvedValueOnce({ ok: true, changed: true });
    const shop = makeCtx(ext({ tabId: 3, url: "https://shop.example/cart" }, tabAct), false);
    const r = await act(shop, { tabId: 3, intent: "click", params: { text: "Оплатить" } });
    expect(shop.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    expect(tabAct).toHaveBeenCalledTimes(1); // повтор после отказа не ушёл
  });

  it("грант снят («стоп») — вопрос возвращается", async () => {
    say("пройди все тесты");
    say("стоп");
    const c = makeCtx(ext(VIEW), false);
    await act(c, { tabId: 4, intent: "click", params: { text: "Пройти тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
  });
});

// ---------- проводка ПЕТЛЁЙ: реплика владельца → handleUserText → инструмент → гейт ----------
function loopSession() {
  const requestConfirm = vi.fn((req: ConfirmRequest): Promise<ConfirmResult> => Promise.resolve({ requestId: req.requestId, approved: true, outcome: "approved" }));
  const sendAction = vi.fn(async (): Promise<ActionResult> => ({ commandId: "c", ok: true, durationMs: 1 }));
  return { sessionId: "s1", userId: U, sendAction, send: vi.fn(), requestConfirm } as unknown as Session & { requestConfirm: typeof requestConfirm };
}
function loopDeps(llm: MockLlmProvider, e: ReturnType<typeof ext>): AgentDeps {
  return {
    memory: new WorkingMemory(),
    llm,
    episodic: new InMemoryEpisodicMemory(new HashEmbeddingProvider()),
    web: new MockWebProvider(),
    models: { haiku: "h", sonnet: "s", fable: "f" },
    spend: new SpendGuard(),
    userId: U,
    tasks: new TaskManager(),
    ext: e,
  } as unknown as AgentDeps;
}
const CLICK = { id: "t1", name: "browser_act", input: { tabId: 4, intent: "click", params: { text: "Пройти тест" } } };

describe("проводка ПЕТЛЁЙ (handleUserText)", () => {
  it("«пройди все тесты» → модель жмёт «Пройти тест» → владельца НЕ спрашивают, клик ушёл", async () => {
    const e = ext(VIEW);
    const s = loopSession();
    await handleUserText(s, "Джарвис, пройди все мини-тесты", loopDeps(new MockLlmProvider([{ toolUses: [CLICK] }, { text: "Начал, сэр." }]), e));
    expect(s.requestConfirm).not.toHaveBeenCalled();
    expect(e.tabAct).toHaveBeenCalledTimes(1);
  });

  it("реплика без учебного поручения («нажми кнопку на странице») → тот же клик спрашивает владельца", async () => {
    const e = ext(VIEW);
    const s = loopSession();
    await handleUserText(s, "нажми кнопку на странице", loopDeps(new MockLlmProvider([{ toolUses: [CLICK] }, { text: "Готово." }]), e));
    expect(s.requestConfirm).toHaveBeenCalledTimes(1);
  });

  it("реплика принята окном БЕЗ «Джарвис» (viaWake=false, фон) → грант не выдан, спрашивает", async () => {
    const e = ext(VIEW);
    const s = loopSession();
    await handleUserText(s, "пройди все мини-тесты", loopDeps(new MockLlmProvider([{ toolUses: [CLICK] }, { text: "Готово." }]), e), undefined, { viaWake: false });
    expect(s.requestConfirm).toHaveBeenCalledTimes(1);
  });
});

// ---------- браузер через GUI (act по окну Chrome): место — по живой вкладке ----------
describe("GUI-гейт: окно Chrome с учебной вкладкой", () => {
  const lmsTab = { tabId: 1, url: "https://eos.imes.su/mod/quiz/view.php?id=5", title: "Тест 1", active: true };
  const bankTab = { tabId: 2, url: "https://online.sberbank.ru/pay", title: "СберБанк Онлайн", active: true };
  function guiSetup(tab: typeof lmsTab) {
    const client = fakeClient({});
    const confirm = vi.fn(async () => ({ approved: false, outcome: "denied" as const }));
    const ctx = {
      session: { sendAction: client.sendAction },
      userId: U,
      confirm,
      systemContext: () => `Окна: 3 · На переднем плане: chrome «${tab.title} - Google Chrome» · Пользователь: за ПК`,
      ext: { connected: true, tabList: vi.fn(async () => ({ tabs: [tab], count: 1 })) },
    } as unknown as ToolContext;
    return { ctx, confirm, sent: () => client.sent.filter((c) => c.kind === "gui.act") as Array<ActionCommand & { approval?: { grants: unknown[] } }> };
  }

  it("КОНТРОЛЬ без гранта: «Отправить» в окне с LMS-вкладкой спрашивает", async () => {
    const s = guiSetup(lmsTab);
    await dispatchTool("act", { app: "Chrome", target: "Отправить" }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(s.sent()).toHaveLength(0);
  });

  it("с грантом: то же действие уходит с грантом на хост, без вопроса", async () => {
    say("пройди все тесты");
    const s = guiSetup(lmsTab);
    await dispatchTool("act", { app: "Chrome", target: "Отправить" }, s.ctx);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.sent()[0]!.approval?.grants).toEqual([{ signature: "click:отправить", process: "chrome", host: "eos.imes.su", count: 1 }]);
  });

  it("с грантом окно банка по-прежнему спрашивает", async () => {
    say("пройди все тесты");
    const s = guiSetup(bankTab);
    await dispatchTool("act", { app: "Chrome", target: "Отправить" }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(s.sent()).toHaveLength(0);
  });
});
