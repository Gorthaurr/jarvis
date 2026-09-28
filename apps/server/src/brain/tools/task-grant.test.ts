/**
 * «Поручение = разрешение» для учебных систем (28.09): реплика владельца «пройди тест/курс» выдаёт грант на LMS-коммиты
 * (старт попытки, проверка, сдача) — вопрос §14 на них не задаётся. Остальное §14 (банк, мессенджер, магазин, оплата,
 * удаление) — как было. Ревью 28.09 (H1/H2/M1-M5) закреплено тестами: подстрока URL, подпись кнопки, отзыв на уровне
 * управления задачами, отрицание, ложные срабатывания, клиентский рубеж needsApproval.
 * Часть 1 — политика выдачи; часть 2 — где действует; часть 3 — проводка через dispatchTool; часть 4 — отзыв;
 * часть 5 — ПЕТЛЁЙ (handleUserText); часть 6 — GUI-гейты.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult, ConfirmRequest, ConfirmResult } from "@jarvis/protocol";
import { SpendGuard } from "../../billing/index.js";
import type { SessionContext } from "../../gateway/router-ws.js";
import type { Session } from "../../gateway/session.js";
import { handleControlUtterance, handleTaskControl } from "../../gateway/task-control.js";
import { MockLlmProvider } from "../../integrations/llm.js";
import { HashEmbeddingProvider } from "../../integrations/openai-embeddings.js";
import { MockWebProvider } from "../../integrations/web.js";
import { InMemoryEpisodicMemory } from "../../memory/episodic.js";
import { WorkingMemory } from "../../memory/working.js";
import { type AgentDeps, handleUserText } from "../agent/index.js";
import { TaskManager } from "../tasks/manager.js";
import { type ToolContext, dispatchTool } from "./dispatch.js";
import { fakeClient } from "./test-support/fake-client.js";
import { EDU_GRANT_CAP_MS, EDU_GRANT_MS, eduGrantActive, eduGrantedAt, eduGuiGranted, eduLabelOk, isLmsUrlStrict, noteOwnerTurn, resetTaskGrants } from "./task-grant.js";

const U = "u1";
const owner = { userId: U };
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
    "нужно пройти все тесты", // M3
    "пройти тест по курсу",
    "хочу чтобы ты прошёл тест",
    "прошел все тесты в ЭИОС",
    "закончи тесты по курсу",
    "заверши курс",
    "сделай домашку",
    "сделай лабораторную",
    "выполни задание по физике",
    "Пройди тест, не надо переспрашивать", // M2: отрицание ПОСЛЕ глагола главную формулировку не снимает
    "пройди все тесты и не надо каждый раз спрашивать",
    "Пройди тест а потом стоп",
    "пройди тест и отмени напоминание про кофе",
    // раунд 2 (#4): «не спрашивай» — в ДРУГОЙ клаузе; именно жалоба владельца
    "Джарвис, не спрашивай разрешения, пройди все тесты",
    "не спрашивай меня, просто пройди тесты",
    "без лишних вопросов пройди все тесты",
    "Ничего не спрашивай, пройди тест",
    "Я не могу, пройди тесты вместо меня",
    "Джарвис я сейчас не могу, пройди все тесты в ЭИОС",
    "Не забудь пройти все тесты",
  ])("«%s» — выдаёт", (t) => {
    say(t);
    expect(eduGrantActive(U)).toBe(true);
  });

  it.each([
    "Джарвис, ты меня слышишь?",
    "Прием.",
    "Джарвис, в м с зайди.",
    "открой хром и ютуб",
    "реши уравнение",
    "данные",
    // M1: отрицание слева от глагола
    "не выполняй задание",
    "не решай тест",
    "я не хочу чтобы ты проходил тест",
    "не надо проходить тесты",
    // M4: разработчик и деньги
    "покажи курс доллара и сделай скриншот",
    "узнай курс биткоина и сделай заметку",
    "сделай тест микрофона",
    "сделай модуль авторизации",
    "запусти тесты в проекте и выполни сборку",
    "включи лекцию и сделай потише",
    // вопросы и напоминания
    "когда сдавать экзамен?",
    "напомни завтра сдать зачёт",
    "как пройти тест по физике",
  ])("«%s» — не выдаёт", (t) => {
    say(t);
    expect(eduGrantActive(U)).toBe(false);
  });

  it("реплика без «Джарвис» (фон, ТВ) и машинный реэнтри не выдают", () => {
    say("пройди все тесты", false);
    expect(eduGrantActive(U)).toBe(false);
  });

  it("«иди/давай/да/доделай» продлевает выданный грант (но не выдаёт); потолок от выдачи — 8 ч (L4)", () => {
    say("иди");
    expect(eduGrantActive(U)).toBe(false);
    say("пройди все тесты", true, 1_000);
    say("Джарвис, иди.", true, 1_000 + EDU_GRANT_MS - 10);
    expect(eduGrantActive(U, 1_000 + EDU_GRANT_MS + 5)).toBe(true); // без продления кончился бы
    expect(eduGrantActive(U, 1_000 + 2 * EDU_GRANT_MS)).toBe(false);
    let t = 1_000 + EDU_GRANT_MS - 10;
    for (let i = 0; i < 20; i += 1) {
      t += EDU_GRANT_MS - 20;
      say("да", true, t);
    }
    expect(eduGrantActive(U, 1_000 + EDU_GRANT_CAP_MS + 5)).toBe(false);
  });

  it("посторонняя реплика грант не продлевает; «данные» — не «да»", () => {
    say("пройди все тесты", true, 1_000);
    say("какая погода", true, 1_000 + EDU_GRANT_MS - 10);
    say("данные", true, 1_000 + EDU_GRANT_MS - 10);
    expect(eduGrantActive(U, 1_000 + EDU_GRANT_MS + 5)).toBe(false);
  });

  it.each(["отмена", "отмени всё", "Джарвис, отмени", "не сдавай пока", "стоп, не сдавай тест", "вырубись", "прекрати"])("«%s» — снимает грант", (t) => {
    say("пройди все тесты");
    say(t);
    expect(eduGrantActive(U)).toBe(false);
  });

  it.each(["стоп", "стой", "хватит", "Джарвис, хватит", "заткнись"])("раунд 2 (#3): «%s» = «замолчи», учебная задача идёт — грант ЖИВ", (t) => {
    say("пройди все тесты");
    say(t);
    expect(eduGrantActive(U)).toBe(true);
  });

  it("M2: «отмени напоминание про кофе» и «не надо каждый раз спрашивать» грант НЕ снимают", () => {
    say("пройди все тесты");
    say("отмени напоминание про кофе");
    say("не надо каждый раз спрашивать");
    expect(eduGrantActive(U)).toBe(true);
  });

  it("грант чужого userId не действует", () => {
    say("пройди все тесты");
    expect(eduGrantActive("other")).toBe(false);
  });
});

describe("где действует (H1): строгий адрес, известная вкладка, подпись LMS-коммита, ход владельца", () => {
  beforeEach(() => say("пройди все тесты"));
  const lms = { host: "eos.imes.su", url: "https://eos.imes.su/mod/quiz/view.php?id=5" };

  it("адрес: путь LMS — да; подстрока в query/fragment, data:/blob:/file: — нет", () => {
    expect(isLmsUrlStrict(lms.url)).toBe(true);
    expect(isLmsUrlStrict("https://shop.example/checkout?next=/mod/quiz/view.php")).toBe(false);
    expect(isLmsUrlStrict("https://shop.example/pay#/mod/assign/view.php")).toBe(false);
    expect(isLmsUrlStrict("data:text/html,/mod/quiz/view.php")).toBe(false);
    expect(isLmsUrlStrict("blob:https://evil.example/mod/quiz/view.php")).toBe(false);
    expect(isLmsUrlStrict("file:///C:/x/pay/mod/quiz/view.php")).toBe(false);
    expect(isLmsUrlStrict("")).toBe(false);
  });

  it("подпись: старт попытки / проверка / сдача — да; «Оплатить», «Удалить ответ», «Отправить», пусто — нет", () => {
    for (const ok of ["Пройти тест", "Начать попытку", "Проверить", "Отправить всё и завершить тест", "Отправить на проверку", "Сохранить изменения"]) expect(eduLabelOk(ok)).toBe(true);
    for (const no of ["Оплатить заказ", "Удалить ответ", "Отправить", "Опубликовать", "", "  "]) expect(eduLabelOk(no)).toBe(false);
    // раунд 2 (#7): регэксп LMS неякорный — подпись из ДВУХ действий (оплата + старт) не LMS-коммит
    for (const mix of ["Оплатить и пройти тест", "Удалить все попытки и начать попытку", "Отправить платёж и отправить на проверку", "Delete account / attempt quiz now", "Начать попытку и открыть чужой кабинет", "Пройти тест или что-то ещё"]) expect(eduLabelOk(mix)).toBe(false);
    for (const real of ["Пройти тест (сейчас)", "Attempt quiz now", "Re-attempt quiz", "Начать попытку", "Отправить всё и завершить тест", "Проверить", "Сохранить"]) expect(eduLabelOk(real)).toBe(true);
    expect(eduLabelOk(["Удалить", "Пройти тест"])).toBe(false); // раунд 2: одна из видимых подписей цели — коммит вне LMS → нет
    expect(eduLabelOk(["Пройти тест", "Пройти тест (сейчас)"])).toBe(true);
  });

  it("место × подпись: только LMS-путь И LMS-подпись; неизвестная вкладка, опасный хост, машинный ход — нет", () => {
    expect(eduGrantedAt(owner, lms, "Пройти тест")).toBe(true);
    expect(eduGrantedAt(owner, lms, "Удалить ответ")).toBe(false);
    expect(eduGrantedAt(owner, { host: "shop.example", url: "https://shop.example/checkout?next=/mod/quiz/view.php" }, "Пройти тест")).toBe(false);
    expect(eduGrantedAt(owner, { ...lms, unknown: true }, "Пройти тест")).toBe(false);
    expect(eduGrantedAt(owner, { host: "", url: "file:///C:/x/mod/quiz/view.php", unknown: true }, "Пройти тест")).toBe(false);
    expect(eduGrantedAt(owner, { host: "online.sberbank.ru", url: "https://online.sberbank.ru/mod/quiz/view.php?id=5" }, "Пройти тест")).toBe(false);
    expect(eduGrantedAt({ userId: U, machineTurn: true }, lms, "Пройти тест")).toBe(false); // L7
    expect(eduGrantedAt({ userId: U, origin: "proactive" }, lms, "Пройти тест")).toBe(false);
  });

  it("GUI: категория edu + строгий адрес + каждая сигнатура — LMS-подпись", () => {
    const place = { category: "edu", host: lms.host, url: lms.url };
    expect(eduGuiGranted(owner, place, ["click:пройти тест"])).toBe(true);
    expect(eduGuiGranted(owner, place, ["click:пройти тест", "click:удалить"])).toBe(false);
    expect(eduGuiGranted(owner, place, ["key:enter"])).toBe(false);
    expect(eduGuiGranted(owner, { ...place, category: "messenger" }, ["click:пройти тест"])).toBe(false);
    expect(eduGuiGranted(owner, { ...place, url: "https://shop.example/x?next=/mod/quiz/view.php" }, ["click:пройти тест"])).toBe(false);
    expect(eduGuiGranted(owner, place, [])).toBe(false);
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
function makeCtx(e: unknown, approved = false, over: Partial<ToolContext> = {}): ToolContext & { confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn(async () => ({ approved, outcome: approved ? "approved" : "denied" }));
  return { session: { sendAction: okSend }, userId: U, confirm, ext: e, ...over } as unknown as ToolContext & { confirm: ReturnType<typeof vi.fn> };
}
const act = (c: ToolContext, input: Record<string, unknown>) => dispatchTool("browser_act", input, c);
const VIEW = { tabId: 4, url: "https://eos.imes.su/mod/quiz/view.php?id=5" };
const SUMMARY = { tabId: 4, url: "https://eos.imes.su/mod/quiz/summary.php?attempt=42" };
const ASSIGN = { tabId: 4, url: "https://eos.imes.su/mod/assign/view.php?id=4" };

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

  it("H1: на LMS-странице «Удалить ответ» по-прежнему спрашивает — грант только на LMS-подписи", async () => {
    say("пройди все тесты");
    const e = ext(ASSIGN);
    const c = makeCtx(e, false);
    const r = await act(c, { tabId: 4, intent: "click", params: { text: "Удалить ответ" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    expect(e.tabAct).not.toHaveBeenCalled();
  });

  it("H1: чужой сайт с «/mod/quiz/view.php» в query — «Оплатить заказ» спрашивает", async () => {
    say("пройди все тесты");
    const e = ext({ tabId: 4, url: "https://shop.example/checkout?next=/mod/quiz/view.php" });
    const c = makeCtx(e, false);
    const r = await act(c, { tabId: 4, intent: "click", params: { text: "Оплатить заказ" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    expect(e.tabAct).not.toHaveBeenCalled();
  });

  it("H1: и «Пройти тест» на таком чужом сайте (не LMS по пути) спрашивает", async () => {
    say("пройди все тесты");
    const e = ext({ tabId: 4, url: "https://shop.example/checkout?next=/mod/quiz/view.php" });
    const c = makeCtx(e, false);
    await act(c, { tabId: 4, intent: "click", params: { text: "Пройти тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
  });

  it("с грантом: browser_batch из LMS-коммитов — без вопроса; с «Удалить ответ» среди шагов — ОДИН вопрос на весь берст", async () => {
    say("пройди все тесты");
    const e = ext(ASSIGN);
    const c = makeCtx(e, false);
    await dispatchTool("browser_batch", { tabId: 4, steps: [{ intent: "click", params: { text: "Отправить на проверку" } }] }, c);
    expect(c.confirm).not.toHaveBeenCalled();
    expect(e.tabBatch).toHaveBeenCalledTimes(1);
    const e2 = ext(ASSIGN);
    const c2 = makeCtx(e2, false);
    await dispatchTool("browser_batch", { tabId: 4, steps: [{ intent: "click", params: { text: "Отправить на проверку" } }, { intent: "click", params: { text: "Удалить ответ" } }] }, c2);
    expect(c2.confirm).toHaveBeenCalledTimes(1);
    expect(e2.tabBatch).not.toHaveBeenCalled();
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

  it("с грантом мессенджер спрашивает про Enter; обычный магазин — «Оплатить» тоже (суд страницы)", async () => {
    say("пройди все тесты");
    const wa = makeCtx(ext({ tabId: 8, url: "https://web.whatsapp.com/" }), false);
    await act(wa, { tabId: 8, intent: "key", params: { combo: "Enter" } });
    expect(wa.confirm).toHaveBeenCalledTimes(1);
    const tabAct = vi
      .fn()
      .mockRejectedValueOnce(new Error("tab.act click: commit_confirm: Оплатить"))
      .mockResolvedValueOnce({ ok: true, changed: true });
    const shop = makeCtx(ext({ tabId: 3, url: "https://shop.example/cart" }, tabAct), false);
    const r = await act(shop, { tabId: 3, intent: "click", params: { text: "Оплатить" } });
    expect(shop.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    expect(tabAct).toHaveBeenCalledTimes(1);
  });

  it("L7: машинный ход (наблюдение/проактив) грантом не пользуется", async () => {
    say("пройди все тесты");
    const c = makeCtx(ext(VIEW), false, { machineTurn: true });
    await act(c, { tabId: 4, intent: "click", params: { text: "Пройти тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
  });

  it("грант снят («отмена») — вопрос возвращается", async () => {
    say("пройди все тесты");
    say("отмена");
    const c = makeCtx(ext(VIEW), false);
    await act(c, { tabId: 4, intent: "click", params: { text: "Пройти тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
  });
});

describe("раунд 2: подпись гранта = подпись СНИМКА, а не слова модели (#1, #8)", () => {
  function snapExt(tab: Tab, ref: string, name: string) {
    const e = ext(tab);
    e.tabInspect = vi.fn(async () => ({ url: tab.url, title: "t", count: 1, elements: [{ ref, tag: "button", role: "button", name }] }));
    return e;
  }

  it("browser_batch: снимок e1=«Удалить работу», модель называет шаг «Отправить на проверку» → ВОПРОС, в расширение не ушло", async () => {
    say("пройди все тесты");
    const e = snapExt(ASSIGN, "e1", "Удалить работу");
    const c = makeCtx(e, false);
    await dispatchTool("browser_inspect", { url: ASSIGN.url, tabId: 4 }, c);
    await dispatchTool("browser_batch", { tabId: 4, steps: [{ intent: "click", ref: "e1", params: { text: "Отправить на проверку" } }] }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(e.tabBatch).not.toHaveBeenCalled();
  });

  it("browser_batch: снимок e1=«Оплатить курс», имя от модели «Пройти тест» → ВОПРОС", async () => {
    say("пройди все тесты");
    const e = snapExt(ASSIGN, "e1", "Оплатить курс");
    const c = makeCtx(e, false);
    await dispatchTool("browser_inspect", { url: ASSIGN.url, tabId: 4 }, c);
    await dispatchTool("browser_batch", { tabId: 4, steps: [{ intent: "click", ref: "e1", params: { name: "Пройти тест" } }] }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(e.tabBatch).not.toHaveBeenCalled();
  });

  it("контроль: снимок e1=«Отправить на проверку» и то же имя от модели → без вопроса (грант работает по правде)", async () => {
    say("пройди все тесты");
    const e = snapExt(ASSIGN, "e1", "Отправить на проверку");
    const c = makeCtx(e, false);
    await dispatchTool("browser_inspect", { url: ASSIGN.url, tabId: 4 }, c);
    await dispatchTool("browser_batch", { tabId: 4, steps: [{ intent: "click", ref: "e1", params: { text: "Отправить на проверку" } }] }, c);
    expect(c.confirm).not.toHaveBeenCalled();
    expect(e.tabBatch).toHaveBeenCalledTimes(1);
  });

  it("#8 (батч): ref, которого нет в снимках сессии, + подпись модели «Отправить на проверку» → грант НЕ применяется, вопрос", async () => {
    say("пройди все тесты");
    const e = ext(ASSIGN);
    const c = makeCtx(e, false);
    await dispatchTool("browser_batch", { tabId: 4, steps: [{ intent: "click", ref: "e9", params: { text: "Отправить на проверку" } }] }, c);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(e.tabBatch).not.toHaveBeenCalled();
  });

  it("#8: ref, которого нет в снимках сессии (реконнект/вытеснение), + подпись модели «Пройти тест» → грант НЕ применяется, вопрос", async () => {
    say("пройди все тесты");
    const e = ext(VIEW);
    const c = makeCtx(e, false);
    await act(c, { tabId: 4, intent: "click", ref: "e9", params: { text: "Пройти тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(e.tabAct).not.toHaveBeenCalled();
  });
});

// ---------- H2: отзыв на уровне управления задачами (до handleUserText) ----------
function controlCtx() {
  const tasks = new TaskManager();
  tasks.create({ userId: U, sessionId: "s1", goal: "пройти мини-тесты" });
  const send = vi.fn();
  return {
    session: { sessionId: "s1", userId: U, send },
    voice: { onVadEvent: vi.fn(), clearPendingSpeech: vi.fn(), speakQueued: vi.fn(), quiet: vi.fn(), speak: vi.fn() },
    agentDeps: { tasks },
  } as unknown as SessionContext;
}

describe("H2: «отмени/вырубись/стоп» перехватывает управление задачами — грант снимается ТАМ", () => {
  it.each(["отмени", "Джарвис, отмени всё", "отмена", "прекрати", "вырубись", "стоп, не сдавай тест"])("«%s» при идущей задаче → грант снят", (t) => {
    say("пройди все тесты");
    handleControlUtterance(controlCtx(), t, "voice");
    expect(eduGrantActive(U)).toBe(false);
  });

  it.each(["тишина", "Джарвис, выключись", "отстань", "это не призыв к действию был", "брось это"])("раунд 2 (#2): «%s» отменяет/глушит задачи → грант снят (по ФАКТУ отмены, не по тексту)", (t) => {
    say("пройди все тесты");
    const ctx = controlCtx();
    const hadTask = (ctx.agentDeps.tasks as TaskManager).activeForUser(U, undefined, false).length > 0;
    handleControlUtterance(ctx, t, "voice");
    const stillActive = (ctx.agentDeps.tasks as TaskManager).activeForUser(U, undefined, false).length > 0;
    if (hadTask && !stillActive) expect(eduGrantActive(U)).toBe(false); // задачи отменены — грант ушёл вместе с ними
  });

  it.each(["стоп", "стой", "хватит", "заткнись"])("раунд 2 (#3): «%s» при идущей учебной задаче = замолчать; задача жива → грант жив", (t) => {
    say("пройди все тесты");
    const ctx = controlCtx();
    handleControlUtterance(ctx, t, "voice");
    const stillActive = (ctx.agentDeps.tasks as TaskManager).activeForUser(U, undefined, false).length > 0;
    if (stillActive) expect(eduGrantActive(U)).toBe(true);
  });

  it("кнопка «стоп» (cancel) в UI снимает грант", () => {
    say("пройди все тесты");
    handleTaskControl(controlCtx(), "cancel", undefined, "ui");
    expect(eduGrantActive(U)).toBe(false);
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

// ---------- GUI: окно Chrome с учебной вкладкой; клиентский рубеж needsApproval ----------
describe("GUI-гейты: окно Chrome с учебной вкладкой", () => {
  const lmsTab = { tabId: 1, url: "https://eos.imes.su/mod/quiz/view.php?id=5", title: "Тест 1", active: true };
  const bankTab = { tabId: 2, url: "https://online.sberbank.ru/pay", title: "СберБанк Онлайн", active: true };
  function guiSetup(tabs: Array<typeof lmsTab>, title: string, need?: () => unknown) {
    const client = fakeClient(need ? ({ need } as never) : {});
    const confirm = vi.fn(async () => ({ approved: false, outcome: "denied" as const }));
    const ctx = {
      session: { sendAction: client.sendAction },
      userId: U,
      confirm,
      systemContext: () => `Окна: 3 · На переднем плане: chrome «${title} - Google Chrome» · Пользователь: за ПК`,
      ext: { connected: true, tabList: vi.fn(async () => ({ tabs, count: tabs.length })) },
    } as unknown as ToolContext;
    return { ctx, confirm, sent: () => client.sent.filter((c) => c.kind === "gui.act") as Array<ActionCommand & { approval?: { grants: unknown[] } }> };
  }

  it("КОНТРОЛЬ без гранта: «Отправить на проверку» в окне с LMS-вкладкой спрашивает", async () => {
    const s = guiSetup([lmsTab], "Тест 1");
    await dispatchTool("act", { app: "Chrome", target: "Отправить на проверку" }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
    expect(s.sent()).toHaveLength(0);
  });

  it("с грантом: LMS-коммит уходит с грантом на хост, без вопроса", async () => {
    say("пройди все тесты");
    const s = guiSetup([lmsTab], "Тест 1");
    await dispatchTool("act", { app: "Chrome", target: "Отправить на проверку" }, s.ctx);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.sent()[0]!.approval?.grants).toEqual([{ signature: "click:отправить на проверку", process: "chrome", host: "eos.imes.su", count: 1 }]);
  });

  it("H1: с грантом обычный «Отправить» в LMS-окне и окно банка — по-прежнему спрашивают", async () => {
    say("пройди все тесты");
    const a = guiSetup([lmsTab], "Тест 1");
    await dispatchTool("act", { app: "Chrome", target: "Отправить" }, a.ctx);
    expect(a.confirm).toHaveBeenCalledTimes(1);
    const b = guiSetup([bankTab], "СберБанк Онлайн");
    await dispatchTool("act", { app: "Chrome", target: "Отправить на проверку" }, b.ctx);
    expect(b.confirm).toHaveBeenCalledTimes(1);
    expect(b.sent()).toHaveLength(0);
  });

  it("M5: клиентский рубеж needsApproval — LMS-коммит с грантом проходит без вопроса, повтор идёт с грантом", async () => {
    say("пройди все тесты");
    const need = () => ({ signature: "click:пройти тест", process: "chrome", category: "web", windowTitle: "Тест 1 - Google Chrome", hwnd: 9 });
    const s = guiSetup([lmsTab], "Тест 1", need);
    const r = await dispatchTool("act", { app: "Катя", target: "Отправить" }, s.ctx);
    expect(r.isError).toBe(false);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.sent()[1]!.approval?.grants).toEqual([{ signature: "click:пройти тест", process: "chrome", hwnd: 9, host: "eos.imes.su", count: 1 }]);
  });

  it("M5 контроль: тот же needsApproval БЕЗ гранта — вопрос", async () => {
    const need = () => ({ signature: "click:пройти тест", process: "chrome", category: "web", windowTitle: "Тест 1 - Google Chrome", hwnd: 9 });
    const s = guiSetup([lmsTab], "Тест 1", need);
    await dispatchTool("act", { app: "Катя", target: "Отправить" }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
  });

  it("L6: два активных окна с совпавшим заголовком (учебная и банк) → берётся строже, грант не применяется", async () => {
    say("пройди все тесты");
    const s = guiSetup([lmsTab, { ...bankTab, title: "Тест 1" }], "Тест 1");
    await dispatchTool("act", { app: "Chrome", target: "Отправить на проверку" }, s.ctx);
    expect(s.confirm).toHaveBeenCalledTimes(1);
  });
});
