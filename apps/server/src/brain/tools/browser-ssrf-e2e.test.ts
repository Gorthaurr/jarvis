/**
 * B-14 (W4) СКВОЗЬ стык: настоящий dispatchTool сервера → настоящий service worker расширения (background.js в vm) →
 * настоящие page-функции в headless Chromium (стенд apps/extension/test/cdp-harness). Страница подкладывает ссылку на
 * «роутер» (127.0.0.1, фикстура с секретом), модель жмёт её browser_act — вкладка уходит во внутреннюю сеть. Chrome
 * владельца запрос сделает (его предотвращает браузер, не сервер), но СОДЕРЖИМОЕ к модели не доходит: browser_read,
 * browser_inspect и снимок вкладки — честный отказ. Нет Chrome — пропуск, как у стенда.
 *
 * Реверт-проверка (из копии): privateTabRead/privateActResult → всегда null — «секрет не дошёл до модели» красный.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchTool, type ToolContext } from "./dispatch.js";

type Page = { open(u: string): Promise<void>; eval(e: string): Promise<unknown>; close(): Promise<void> };
type Env = Record<"tabRead" | "tabInspect" | "tabAct" | "tabCapture", (...a: unknown[]) => Promise<unknown>>;
interface Harness {
  findChrome(): string | null;
  launchPage(): Promise<Page>;
  fixtureUrl(n: string): string;
  swOnPage(p: Page): { env: Env };
}
const harness = (await import(new URL("../../../../extension/test/cdp-harness.mjs", import.meta.url).href)) as Harness;

const SHOP = "https://shop.example/cart";

describe.skipIf(!harness.findChrome())("B-14: вкладку владельца увели во внутреннюю сеть — модель содержимого не получает", () => {
  let page: Page;
  let router: Server;
  let routerPort = 0;
  const routerHits: string[] = [];

  beforeAll(async () => {
    router = createServer((q, s) => {
      routerHits.push(q.url ?? "/");
      s.setHeader("content-type", "text/html; charset=utf-8");
      s.end(`<title>Router</title><h1>ROUTER-SECRET admin:hunter2</h1><button id="reboot">Перезагрузить</button>`);
    });
    await new Promise<void>((r) => router.listen(0, "127.0.0.1", () => r()));
    const a = router.address();
    routerPort = typeof a === "object" && a ? a.port : 0;
    page = await harness.launchPage();
  }, 60_000);
  afterAll(async () => {
    await page?.close();
    await new Promise((r) => router?.close(() => r(undefined)));
  });

  /** Сервер ↔ SW ↔ страница: живой адрес вкладки (tabList) — из самой страницы, как у расширения. */
  async function wire() {
    await page.open(harness.fixtureUrl("form.html"));
    await page.eval(`document.body.insertAdjacentHTML("beforeend", '<a id="evil" href="http://127.0.0.1:${routerPort}/admin">Скидки</a>')`);
    const { env } = harness.swOnPage(page);
    const live = async () => String(await page.eval("location.href").catch(() => ""));
    const ext = {
      connected: true,
      tabRead: (_u?: string, _t?: number, q?: string) => env.tabRead("", 1, q ?? ""),
      tabInspect: (_u?: string, q?: string, cap?: number) => env.tabInspect("", q ?? "", cap ?? 200, 1),
      tabAct: (_u: string, intent: string, params?: Record<string, unknown>) => env.tabAct("", intent, params, 1),
      tabCapture: vi.fn(async () => ({ ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 1, height: 1 })),
      tabList: async () => ({ tabs: [{ tabId: 1, url: await live(), active: true, status: "complete" }] }),
      openOrFocus: vi.fn(async () => ({ tabId: 1 })),
    };
    const ctx = { session: { sendAction: vi.fn() }, userId: "u1", ext, confirm: vi.fn() } as unknown as ToolContext;
    return { ctx, ext, live };
  }

  it("клик по подложенной ссылке → вкладка на 127.0.0.1; act/read/inspect/снимок не отдают ни адреса, ни секрета", async () => {
    const { ctx, ext, live } = await wire();
    const url = SHOP; // цель модели — публичный сайт (страница стенда — file://, расширение действует во вкладке №1)
    const act = await dispatchTool("browser_act", { url, tabId: 1, intent: "click", selector: "#evil" }, ctx);
    for (let i = 0; i < 40 && !(await live()).includes("127.0.0.1"); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await live()).toContain(`127.0.0.1:${routerPort}`); // Chrome владельца ушёл (это факт стенда, не гарда)
    expect(routerHits.length).toBeGreaterThan(0);

    const read = await dispatchTool("browser_read", { url, tabId: 1 }, ctx);
    const inspect = await dispatchTool("browser_inspect", { url, tabId: 1 }, ctx);
    // Снимок по вкладке без адреса цели: расширение снимет ИМЕННО её (host цели пуст) — живой адрес судим до снимка.
    const shot = await dispatchTool("browser_read", { tabId: 1, view: "image" }, ctx);
    for (const r of [read, inspect, shot]) {
      expect(String(r.content)).not.toMatch(/ROUTER-SECRET|hunter2|Перезагрузить|127\.0\.0\.1/u);
      expect(r.isError).toBe(true);
      expect(String(r.content)).toMatch(/внутреннем адресе/u);
    }
    expect(ext.tabCapture).not.toHaveBeenCalled(); // снимок не делали вовсе
    expect(String(act.content)).not.toMatch(/127\.0\.0\.1|ROUTER/u);
  }, 30_000);

  it("обычная вкладка читается как раньше (гард не режет публичное)", async () => {
    const { ctx } = await wire();
    const r = await dispatchTool("browser_read", { url: SHOP, tabId: 1 }, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(String(r.content)).toContain("Форма: поля, галочки");
  }, 30_000);
});
