/**
 * §14 для browser_act, часть 2 (боевой прогон 26.09, Moodle) — ПРОВОДКА через реальный dispatchTool:
 * живой адрес вкладки по tabId, учебные LMS по пути, гард подписи на странице (commit_confirm → вопрос → повтор с
 * guardApproved), окно одобрения для двухшаговой сдачи Moodle, служебные поля гарда от модели не принимаются.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
const okSend: Send = async () => ({ commandId: "c", ok: true, durationMs: 1 });

function makeCtx(ext: unknown, approved = true): ToolContext & { confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn(async () => ({ approved, outcome: approved ? "approved" : "denied" }));
  return { session: { sendAction: okSend }, userId: "u1", confirm, ext } as unknown as ToolContext & { confirm: ReturnType<typeof vi.fn> };
}
function ext(tabs: Array<{ tabId: number; url: string }>, tabAct = vi.fn(async () => ({ ok: true, changed: true }))) {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 5 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: "", title: "", count: 0, elements: [] })),
    tabAct,
    tabList: vi.fn(async () => ({ tabs, count: tabs.length })),
    tabClose: vi.fn(async () => ({ closed: 1 })),
    exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
  };
}
const act = (c: ToolContext, input: Record<string, unknown>) => dispatchTool("browser_act", input, c);
const paramsOf = (tabAct: ReturnType<typeof vi.fn>, i = 0) => tabAct.mock.calls[i]?.[2] as Record<string, unknown>;

describe("browser_act по tabId — место судится по ЖИВОМУ адресу вкладки", () => {
  it("банк по tabId без url: «Перевести» спрашивает; отказ — клика нет (раньше host='' и гейт молчал)", async () => {
    const e = ext([{ tabId: 7, url: "https://online.sberbank.ru/transfer" }]);
    const c = makeCtx(e, false);
    const r = await act(c, { tabId: 7, intent: "click", params: { text: "Перевести" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(r.declined).toBe(true);
    expect(e.tabAct).not.toHaveBeenCalled();
  });

  it("вкладку не нашли — судим строго: «Отправить» спрашивает, нейтральный клик — нет, но гард уходит на страницу", async () => {
    const e = ext([]);
    const c = makeCtx(e, true);
    await act(c, { tabId: 9, intent: "click", params: { text: "Отправить" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    const c2 = makeCtx(ext([]), true);
    await act(c2, { tabId: 9, intent: "click", params: { selector: "#next" } });
    expect(c2.confirm).not.toHaveBeenCalled();
    expect(typeof paramsOf((c2.ext as ReturnType<typeof ext>).tabAct).guard).toBe("string");
  });

  it("обычный сайт — гард на страницу НЕ шлём (лишняя работа и ложные вопросы)", async () => {
    const e = ext([{ tabId: 3, url: "https://example.org/page" }]);
    await act(makeCtx(e), { tabId: 3, intent: "click", params: { selector: "#go" } });
    expect(paramsOf(e.tabAct).guard).toBeUndefined();
  });
});

describe("Moodle: учебная LMS узнаётся по пути страницы", () => {
  const quiz = (page: string) => `https://eos.imes.su/mod/quiz/${page}`;

  it("«Пройти тест» на view.php спрашивает (тратит попытку, запускает таймер)", async () => {
    const e = ext([{ tabId: 4, url: quiz("view.php?id=5") }]);
    const c = makeCtx(e, false);
    await act(c, { tabId: 4, intent: "click", params: { text: "Пройти тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(String(c.confirm.mock.calls[0]?.[0])).toMatch(/учебная система/u);
    expect(e.tabAct).not.toHaveBeenCalled();
  });

  it("на странице попытки выбор ответа, «Следующая страница» и ввод с Enter — без вопросов", async () => {
    const e = ext([{ tabId: 4, url: quiz("attempt.php?attempt=42&cmid=5") }]);
    const c = makeCtx(e);
    await act(c, { tabId: 4, intent: "click", params: { text: "Париж" } });
    await act(c, { tabId: 4, intent: "click", params: { text: "Следующая страница" } });
    await act(c, { tabId: 4, intent: "type", params: { selector: "#a", text: "2", enter: true } });
    expect(c.confirm).not.toHaveBeenCalled();
    expect(e.tabAct).toHaveBeenCalledTimes(3);
  });

  it("«Продолжить текущую попытку» — навигация, «Продолжить» целиком (подтверждение сдачи задания) — коммит", async () => {
    const e = ext([{ tabId: 4, url: quiz("view.php?id=5") }]);
    const c = makeCtx(e);
    await act(c, { tabId: 4, intent: "click", params: { text: "Продолжить текущую попытку" } });
    expect(c.confirm).not.toHaveBeenCalled();
    const e2 = ext([{ tabId: 6, url: "https://eos.imes.su/mod/assign/view.php?id=9&action=submit" }]);
    const c2 = makeCtx(e2);
    await act(c2, { tabId: 6, intent: "click", params: { text: "Продолжить" } });
    expect(c2.confirm).toHaveBeenCalledTimes(1);
  });

  it("клик по СЕЛЕКТОРУ: страница вернула commit_confirm → вопрос → повтор с guardApproved", async () => {
    const tabAct = vi
      .fn()
      .mockRejectedValueOnce(new Error("tab.act click: commit_confirm: Отправить всё и завершить тест"))
      .mockResolvedValueOnce({ ok: true, changed: true });
    const e = ext([{ tabId: 4, url: quiz("summary.php?attempt=42") }], tabAct);
    const c = makeCtx(e, true);
    const r = await act(c, { tabId: 4, intent: "click", params: { selector: ".btn-finishattempt button" } });
    expect(r.isError).toBe(false);
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(String(c.confirm.mock.calls[0]?.[0])).toMatch(/Отправить всё и завершить тест/u);
    expect(typeof paramsOf(tabAct, 0).guard).toBe("string");
    expect(paramsOf(tabAct, 0).guardApproved).toBeUndefined();
    expect(paramsOf(tabAct, 1).guardApproved).toBe(true);
  });

  it("commit_confirm и отказ владельца — второго клика нет", async () => {
    const tabAct = vi.fn().mockRejectedValueOnce(new Error("tab.act click: commit_confirm: Отправить всё и завершить тест"));
    const e = ext([{ tabId: 4, url: quiz("summary.php?attempt=42") }], tabAct);
    const r = await act(makeCtx(e, false), { tabId: 4, intent: "click", params: { selector: "#fin" } });
    expect(r.declined).toBe(true);
    expect(tabAct).toHaveBeenCalledTimes(1);
  });

  it("двухшаговая сдача: та же подпись в окне сразу после «да» — второй раз не спрашиваем", async () => {
    const e = ext([{ tabId: 4, url: quiz("summary.php?attempt=42") }]);
    const c = makeCtx(e, true);
    await act(c, { tabId: 4, intent: "click", params: { text: "Отправить всё и завершить тест" } });
    await act(c, { tabId: 4, intent: "click", params: { text: "Отправить всё и завершить тест" } });
    expect(c.confirm).toHaveBeenCalledTimes(1);
    expect(e.tabAct).toHaveBeenCalledTimes(2);
  });

  it("окно одобрения — только для учёбы: в мессенджере каждое «Отправить» спрашивается", async () => {
    const e = ext([{ tabId: 8, url: "https://web.whatsapp.com/" }]);
    const c = makeCtx(e, true);
    await act(c, { tabId: 8, intent: "click", params: { text: "Отправить" } });
    await act(c, { tabId: 8, intent: "click", params: { text: "Отправить" } });
    expect(c.confirm).toHaveBeenCalledTimes(2);
  });
});

describe("служебные поля гарда — только от сервера", () => {
  it("модель прислала guardApproved:true — вырезаем, страница всё равно спросит", async () => {
    const e = ext([{ tabId: 7, url: "https://online.sberbank.ru/" }]);
    await act(makeCtx(e), { tabId: 7, intent: "click", params: { selector: "#pay", guardApproved: true, guard: "x^" } });
    const p = paramsOf(e.tabAct);
    expect(p.guardApproved).toBeUndefined();
    expect(p.guard).not.toBe("x^");
    expect(String(p.guard)).toMatch(/отправ/u);
  });
});
