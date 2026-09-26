/**
 * Контракт одобрения §14 СКВОЗЬ стык (W1-ревью р2, NEW-1): настоящий dispatchTool сервера → настоящий service worker
 * расширения (background.js в vm) → настоящие page-функции в headless Chromium (стенд apps/extension/test/cdp-harness).
 * Снимок — живой inspectPageInPage, хинт — rememberRefHints, подпись одобрения — сервер, суд — страница. Моков формы
 * нет: раунд 2 показал, что тест на моке закрепил склейку хинта, которую страница не принимала никогда (2 вопроса).
 * Нет Chrome (CHROME_PATH / стандартные пути) — пропуск, как у стенда.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchTool, type ToolContext } from "./dispatch.js";

type Page = { open(u: string): Promise<void>; eval(e: string): Promise<unknown>; close(): Promise<void> };
type Env = { tabInspect: (...a: unknown[]) => Promise<{ elements: Array<Record<string, string>> }>; tabAct: (...a: unknown[]) => Promise<unknown>; tabBatch: (...a: unknown[]) => Promise<unknown> };
interface Harness {
  findChrome(): string | null;
  launchPage(): Promise<Page>;
  fixtureUrl(n: string): string;
  swOnPage(p: Page): { env: Env };
}
const harness = (await import(new URL("../../../../extension/test/cdp-harness.mjs", import.meta.url).href)) as Harness;

const TG = "https://web.telegram.org/a/";
const BANK = "https://online.sberbank.ru/pay";
const SHOP = "https://shop.example/cart";

describe.skipIf(!harness.findChrome())("§14 сквозь стык: один вопрос владельцу на рискованный шаг по ref", () => {
  let page: Page;
  beforeAll(async () => { page = await harness.launchPage(); }, 60_000);
  afterAll(async () => { await page?.close(); });

  /** Сервер ↔ SW ↔ страница: вкладка №1 — страница стенда, живой адрес для гейта — `url` (хост сайта). */
  async function wire(fixture: string, url: string) {
    await page.open(harness.fixtureUrl(fixture));
    const { env } = harness.swOnPage(page);
    const confirm = vi.fn(async (_summary: string) => ({ approved: true, outcome: "approved" as const }));
    const ext = {
      connected: true,
      openOrFocus: vi.fn(async () => ({ tabId: 1 })),
      tabRead: vi.fn(async () => ({})),
      tabInspect: (_u?: string, q?: string, cap?: number) => env.tabInspect("", q ?? "", cap ?? 200, 1),
      tabAct: (_u: string, intent: string, params?: Record<string, unknown>) => env.tabAct("", intent, params, 1),
      tabBatch: (_u: string, steps: unknown[]) => env.tabBatch("", steps, 1),
      tabList: async () => ({ tabs: [{ tabId: 1, url, active: true, status: "complete" }] }),
      tabClose: vi.fn(async () => ({ closed: 1 })),
      exportCookies: vi.fn(async () => ({ ok: true, count: 0, cookies: [] })),
    };
    const ctx = { session: { sendAction: vi.fn() }, userId: "u1", ext, confirm } as unknown as ToolContext;
    await dispatchTool("browser_inspect", { url, tabId: 1 }, ctx); // сервер запоминает хинты из ЖИВОГО снимка
    const snap = await env.tabInspect("", "", 200, 1);
    const ref = (selector: string): string => snap.elements.find((e) => e.selector === selector)?.ref ?? "";
    return { ctx, confirm, ref };
  }

  it("type+enter по ref в мессенджере, в форме кнопка «Отправить» — 1 вопрос, форма ушла", async () => {
    const { ctx, confirm, ref } = await wire("form.html", TG);
    const r = await dispatchTool("browser_act", { url: TG, tabId: 1, intent: "type", ref: ref("#msg"), text: "привет", enter: true }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await page.eval("window.__c.guarded")).toBe(1);
  });

  it("клик по ref «Оплатить заказ» на банке — 1 вопрос (сервер), страница принимает одобрение ref-а", async () => {
    const { ctx, confirm, ref } = await wire("approve.html", BANK);
    const r = await dispatchTool("browser_act", { url: BANK, tabId: 1, intent: "click", ref: ref("#pay") }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await page.eval("window.__c.pay")).toBe(1);
  });

  it("клик по ref «Оплатить заказ» на обычном сайте — вопрос от страницы, повтор проходит: 1 вопрос", async () => {
    const { ctx, confirm, ref } = await wire("approve.html", SHOP);
    const r = await dispatchTool("browser_act", { url: SHOP, tabId: 1, intent: "click", ref: ref("#pay") }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await page.eval("window.__c.pay")).toBe(1);
  });

  it("key Enter по ref в композере мессенджера (без слов-коммитов) — 1 вопрос, сообщение ушло", async () => {
    const { ctx, confirm, ref } = await wire("approve.html", TG);
    const r = await dispatchTool("browser_act", { url: TG, tabId: 1, intent: "key", ref: ref("#chatbox"), combo: "Enter" }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await page.eval("window.__c.chatbox")).toBe(1);
  });

  it("берст «ввод + Enter по ref» в мессенджере — 1 вопрос на весь берст, форма ушла", async () => {
    const { ctx, confirm, ref } = await wire("form.html", TG);
    const msg = ref("#msg");
    const steps = [{ intent: "type", ref: msg, params: { text: "привет" } }, { intent: "key", ref: msg, params: { combo: "Enter" } }];
    const r = await dispatchTool("browser_batch", { url: TG, tabId: 1, steps }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await page.eval("window.__c.guarded")).toBe(1);
  });

  it("§0 по живому снимку: редактор с «пароль» в ТЕКСТЕ — печатаем; поле с подписью «Пароль» — отказ (srv-tests-2)", async () => {
    const { ctx, ref } = await wire("approve.html", SHOP);
    const r = await dispatchTool("browser_act", { url: SHOP, tabId: 1, intent: "type", ref: ref("#composer"), text: "Новый текст письма" }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(await page.eval("document.getElementById('composer').innerText")).toBe("Новый текст письма");
    const blocked = await dispatchTool("browser_act", { url: SHOP, tabId: 1, intent: "type", ref: ref("#pw2"), text: "hunter2" }, ctx);
    expect(blocked.isError).toBe(true);
    expect(await page.eval("document.getElementById('pw2').value")).toBe("");
  });
});
