import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { dispatchTool, type ToolContext } from "./dispatch.js";

type Send = (cmd: ActionCommand, timeoutMs?: number) => Promise<ActionResult>;
const okSend: Send = async () => ({ commandId: "c", ok: true, durationMs: 1 });

function makeCtx(over: Partial<ToolContext>): ToolContext {
  return { session: { sendAction: okSend }, userId: "u1", ...over } as unknown as ToolContext;
}
function ext(over: Partial<NonNullable<ToolContext["ext"]>> = {}): NonNullable<ToolContext["ext"]> {
  return {
    connected: true,
    openOrFocus: vi.fn(async () => ({ focused: true, tabId: 42 })),
    tabRead: vi.fn(async () => ({})),
    tabInspect: vi.fn(async () => ({ url: "", title: "", count: 0, elements: [] })),
    tabAct: vi.fn(async () => ({ ok: true })),
    tabList: vi.fn(async () => ({ tabs: [], count: 0 })),
    tabClose: vi.fn(async () => ({ closed: 1, tabIds: [1] })),
    exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
    ...over,
  };
}

// § Браузер через расширение: НЕ плодит вкладки (фокус существующей), действует В реальной вкладке,
// целится по tabId/хосту из browser_open (не в «активную»), без open — честная ошибка (не дрейф в Telegram).
describe("browser_* через расширение", () => {
  it("browser_open: расширение фокусит УЖЕ открытую вкладку — НЕ новую, НЕ sendAction", async () => {
    const openOrFocus = vi.fn(async () => ({ focused: true, tabId: 7 }));
    const sendAction = vi.fn<Send>(okSend);
    const r = await dispatchTool(
      "browser_open",
      { url: "https://music.yandex.ru" },
      makeCtx({ ext: ext({ openOrFocus }), session: { sendAction } as unknown as ToolContext["session"] }),
    );
    expect(openOrFocus).toHaveBeenCalledWith("https://music.yandex.ru");
    expect(sendAction).not.toHaveBeenCalled(); // не дублируем вкладку через клиент
    expect(r.isError).toBe(false);
    expect(String(r.content)).toMatch(/переключил/i);
  });

  it("browser_act целится в ВКЛАДКУ из browser_open (url + tabId), а не в «активную» (баг с Telegram)", async () => {
    const openOrFocus = vi.fn(async () => ({ focused: true, tabId: 42 }));
    const tabAct = vi.fn(async () => ({ ok: true }));
    const c = makeCtx({ ext: ext({ openOrFocus, tabAct }) }); // одна сессия для обоих вызовов
    await dispatchTool("browser_open", { url: "https://music.yandex.ru" }, c);
    await dispatchTool("browser_act", { intent: "play" }, c);
    // play ушёл В music.yandex.ru c tabId 42, а НЕ в активную вкладку (= Telegram)
    expect(tabAct).toHaveBeenCalledWith("https://music.yandex.ru", "play", expect.anything(), 42);
  });

  it("browser_read после browser_open читает ТУ ЖЕ вкладку (url + tabId)", async () => {
    const openOrFocus = vi.fn(async () => ({ focused: true, tabId: 9 }));
    const tabRead = vi.fn(async () => ({ title: "Яндекс Музыка", text: "Моя волна" }));
    const c = makeCtx({ ext: ext({ openOrFocus, tabRead }) });
    await dispatchTool("browser_open", { url: "https://music.yandex.ru/" }, c);
    await dispatchTool("browser_read", {}, c);
    expect(tabRead).toHaveBeenCalledWith("https://music.yandex.ru/", 9);
  });

  it("browser_act БЕЗ предшествующего browser_open → ЧЕСТНАЯ ошибка, НЕ бьёт в активную вкладку вслепую", async () => {
    const tabAct = vi.fn(async () => ({ ok: true }));
    const sendAction = vi.fn<Send>(okSend);
    const r = await dispatchTool(
      "browser_act",
      { intent: "play" },
      makeCtx({ ext: ext({ tabAct }), session: { sendAction } as unknown as ToolContext["session"] }),
    );
    expect(tabAct).not.toHaveBeenCalled(); // не дрейфуем в активную (Telegram)
    expect(sendAction).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/сначала открой/i);
  });

  it("browser_act с явным url в input целится в него (без предварительного open)", async () => {
    const tabAct = vi.fn(async () => ({ ok: true }));
    const r = await dispatchTool("browser_act", { intent: "play", url: "https://music.yandex.ru" }, makeCtx({ ext: ext({ tabAct }) }));
    expect(tabAct).toHaveBeenCalledWith("https://music.yandex.ru", "play", expect.anything(), undefined);
    expect(r.isError).toBe(false);
  });

  it("browser_act: не получилось на странице → ЧЕСТНАЯ ошибка (не врём «готово»)", async () => {
    const tabAct = vi.fn(async () => {
      throw new Error("не нашёл кнопку воспроизведения на странице");
    });
    const c = makeCtx({ ext: ext({ tabAct }) });
    await dispatchTool("browser_open", { url: "https://music.yandex.ru" }, c);
    const r = await dispatchTool("browser_act", { intent: "play" }, c);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/не нашёл кнопку/);
  });

  it("МЫШЬ заблокирована в браузерной задаче: input_click после browser_open → ошибка, НЕ sendAction", async () => {
    const sendAction = vi.fn<Send>(okSend);
    const c = makeCtx({ ext: ext(), session: { sendAction } as unknown as ToolContext["session"] });
    await dispatchTool("browser_open", { url: "https://music.yandex.ru" }, c);
    sendAction.mockClear();
    const r = await dispatchTool("input_click", { x: 100, y: 200 }, c);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/browser_act/); // стир на браузерный путь
    expect(sendAction).not.toHaveBeenCalled(); // мышь НЕ поехала (курсор не дёргается)
  });

  it("ui_ground в браузерной задаче тоже заблокирован", async () => {
    const c = makeCtx({ ext: ext() });
    await dispatchTool("browser_open", { url: "https://music.yandex.ru" }, c);
    const r = await dispatchTool("ui_ground", { intent: "кнопка play" }, c);
    expect(r.isError).toBe(true);
  });

  it("P2.1: ПОСЛЕ честного промаха browser_act (canvas/нет DOM) координатный input_click РАЗРЕШЁН (escape-hatch)", async () => {
    const sendAction = vi.fn<Send>(okSend);
    const tabAct = vi.fn(async () => {
      throw new Error("не нашёл элемент — canvas без DOM-кнопки");
    });
    const c = makeCtx({ ext: ext({ tabAct }), session: { sendAction } as unknown as ToolContext["session"] });
    await dispatchTool("browser_open", { url: "https://webgame.example" }, c);
    const miss = await dispatchTool("browser_act", { intent: "click", text: "Старт" }, c);
    expect(miss.isError).toBe(true); // DOM-путь честно не нашёл цель
    sendAction.mockClear();
    const r = await dispatchTool("input_click", { x: 400, y: 300 }, c);
    expect(r.isError).toBe(false); // теперь координатный клик по пикселям разрешён (не глухая блокировка)
    expect(sendAction).toHaveBeenCalled(); // мышь поехала по координатам (зрение→клик)
  });

  it("вне браузерной задачи input_click работает (нативное окно): sendAction вызван, мышь разрешена", async () => {
    const sendAction = vi.fn<Send>(okSend);
    const c = makeCtx({ session: { sendAction } as unknown as ToolContext["session"] }); // НЕ было browser_open
    const r = await dispatchTool("input_click", { x: 10, y: 20 }, c);
    expect(r.isError).toBe(false);
    expect(sendAction).toHaveBeenCalled();
  });

  it("autoplay-блок play → ЧЕСТНАЯ ошибка, НЕ жмёт глобальную медиа-клавишу (не заденет YouTube)", async () => {
    const sendAction = vi.fn<Send>(okSend);
    const tabAct = vi.fn().mockRejectedValue(new Error("клик по play не запустил звук (autoplay)"));
    const c = makeCtx({ ext: ext({ tabAct }), session: { sendAction } as unknown as ToolContext["session"] });
    await dispatchTool("browser_open", { url: "https://music.yandex.ru" }, c);
    const r = await dispatchTool("browser_act", { intent: "play" }, c);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/autoplay/i);
    // КЛЮЧЕВОЕ: system.media НЕ вызывался — глобальная клавиша задела бы YouTube/чужой плеер
    const sentMedia = sendAction.mock.calls.some((call) => (call[0] as { kind?: string }).kind === "system.media");
    expect(sentMedia).toBe(false);
  });

  it("нет расширения → browser_open откат на клиентский browser.open{inDefault} (твой браузер, не CDP-дубль)", async () => {
    const sendAction = vi.fn<Send>(okSend);
    await dispatchTool(
      "browser_open",
      { url: "https://youtube.com" },
      makeCtx({ session: { sendAction } as unknown as ToolContext["session"] }), // ext отсутствует
    );
    expect(sendAction).toHaveBeenCalled();
    expect(sendAction.mock.calls[0]?.[0]).toMatchObject({ kind: "browser.open", inDefault: true });
  });

  it("browser_tabs: список вкладок с tabId/активна/♪ звук — чтобы резолвить «какую вкладку»", async () => {
    const tabList = vi.fn(async () => ({
      tabs: [
        { tabId: 111, title: "Моя Волна — Яндекс Музыка", host: "music.yandex.ru", url: "https://music.yandex.ru/", active: false, audible: true },
        { tabId: 222, title: "YouTube", host: "youtube.com", url: "https://youtube.com/", active: true, audible: false },
      ],
      count: 2,
    }));
    const r = await dispatchTool("browser_tabs", {}, makeCtx({ ext: ext({ tabList }) }));
    expect(r.isError).toBeFalsy();
    expect(tabList).toHaveBeenCalled();
    expect(String(r.content)).toMatch(/music\.yandex\.ru/);
    expect(String(r.content)).toMatch(/♪ звук/); // музыкальная вкладка помечена звуком
    expect(String(r.content)).toMatch(/активна/); // YouTube активна
    expect(String(r.content)).toMatch(/tabId 111/); // tabId показан — модель сможет таргетить точно
  });

  it("browser_close{tabId}: закрывает КОНКРЕТНУЮ вкладку, репортит по факту", async () => {
    const tabClose = vi.fn(async () => ({ closed: 1, tabIds: [222] }));
    const r = await dispatchTool("browser_close", { tabId: 222 }, makeCtx({ ext: ext({ tabClose }) }));
    expect(r.isError).toBeFalsy();
    expect(tabClose).toHaveBeenCalledWith(undefined, 222); // tabClose(url, tabId): без url, точный tabId
    expect(String(r.content)).toMatch(/закрыл/i);
  });

  it("browser_close: ничего не нашлось → честная ошибка (closed:0)", async () => {
    const tabClose = vi.fn(async () => ({ closed: 0, tabIds: [] }));
    const r = await dispatchTool("browser_close", { url: "нет-такого.рф" }, makeCtx({ ext: ext({ tabClose }) }));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/нечего|не наш/i);
  });

  it("browser_act{tabId}: точное попадание в КОНКРЕТНУЮ вкладку (из browser_tabs), а не активную/хост", async () => {
    const tabAct = vi.fn(async () => ({ ok: true }));
    // Передаём ТОЛЬКО tabId (без url) — должен пробросить именно его в ext.tabAct.
    const r = await dispatchTool("browser_act", { intent: "pause", tabId: 111 }, makeCtx({ ext: ext({ tabAct }) }));
    expect(r.isError).toBeFalsy();
    // сигнатура tabAct(url, intent, params, tabId) — точный tabId 4-м аргументом
    expect(tabAct).toHaveBeenCalledWith("", "pause", expect.anything(), 111);
  });

  it("browser_tabs без расширения → честная ошибка (не выдумывает вкладки)", async () => {
    const r = await dispatchTool("browser_tabs", {}, makeCtx({ session: { sendAction: okSend } as unknown as ToolContext["session"] }));
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/не подключено/i);
  });
});
