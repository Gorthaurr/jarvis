/**
 * B-14 (W4): SSRF невидимого браузера — НАСТОЯЩИЙ JarvisBrowser в настоящем Chromium. Серверный гард видит только
 * явный url web_open; редирект, клик по подложенной ссылке и iframe уводили ЗАЛОГИНЕННЫЙ браузер во внутреннюю сеть.
 * Факт — журнал «роутера» (фикстура на 127.0.0.1): до него не дошёл НИ ОДИН запрос; web_open/web_read — честная ошибка.
 *
 * Реверт-проверка (из копии): убрать `guard.start()` (Fetch.enable) в launchWarm → «роутер» получает запросы → красный.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) } }));

import { type Fixture, PUBLIC_HOST, findChrome, fixture, launchJarvisBrowser } from "../test-support/jb-fixtures.js";
import type { JarvisBrowser } from "./jarvis-browser.js";

const chrome = findChrome();

describe.skipIf(!chrome)("B-14: невидимый браузер не уходит во внутреннюю сеть", () => {
  let router: Fixture;
  let shop: Fixture;
  let jb: JarvisBrowser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    router = await fixture({ "/secret": "<h1>ROUTER-SECRET admin:hunter2</h1>", "/frame": "ROUTER-FRAME-SECRET" });
    const R = `http://127.0.0.1:${router.port}`;
    shop = await fixture({
      "/": `<h1>SHOP</h1><a id="l" href="${R}/secret">скидки</a>`,
      "/framed": `<h1>SHOP-FRAMED</h1><iframe src="${R}/frame"></iframe>`,
      "/blank": `<h1>SHOP-BLANK</h1><a id="b" target="_blank" href="${R}/secret">в новой вкладке</a>`,
      "/redir": (_q, _b, res) => void res.writeHead(302, { location: `${R}/secret` }).end(),
    });
    ({ jb, dispose } = launchJarvisBrowser(chrome!));
  }, 60_000);

  afterAll(async () => {
    await dispose?.();
    await router?.close();
    await shop?.close();
  });

  const shopUrl = (p: string) => `http://${PUBLIC_HOST}:${shop.port}${p}`;

  it("web_open публичной страницы работает (гард не ломает обычный путь)", async () => {
    const page = await jb.open(shopUrl("/"));
    expect(page.text).toContain("SHOP");
  }, 30_000);

  it("web_open на URL с 302 во внутреннюю сеть → честная ошибка, «роутер» не получил запросов", async () => {
    await expect(jb.open(shopUrl("/redir"))).rejects.toThrow(/внутренний адрес/u);
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("клик по подложенной ссылке на 127.0.0.1 → запрос не ушёл, web_read — честная ошибка, секрета нет", async () => {
    await jb.open(shopUrl("/"));
    await jb.act("click", { selector: "#l" }).catch(() => "act-error");
    await new Promise((r) => setTimeout(r, 600));
    const read = await jb.read().then((p) => JSON.stringify(p), (e: Error) => `ERR ${e.message}`);
    expect(read).not.toContain("ROUTER-SECRET");
    expect(read).toMatch(/ERR .*внутренний адрес/u);
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("target=_blank на внутренний адрес (с жестом пользователя) → запросов нет: перехват уровня браузера видит новые вкладки", async () => {
    await jb.open(shopUrl("/blank"));
    // Синтетический клик web_act всплывающее окно не откроет (нет активации) — жмём С жестом пользователя через CDP
    // той же вкладки: так новая вкладка РЕАЛЬНО открывается, и проверяется именно перехват, а не блокировщик окон.
    const cdp = (jb as unknown as { cdp: { send(m: string, p: Record<string, unknown>): Promise<unknown> } }).cdp;
    await cdp.send("Runtime.evaluate", { expression: "document.getElementById('b').click()", userGesture: true });
    await new Promise((r) => setTimeout(r, 800));
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("iframe на внутренний адрес не грузится; сама страница читается", async () => {
    const page = await jb.open(shopUrl("/framed"));
    expect(page.text).toContain("SHOP-FRAMED");
    expect(JSON.stringify(page)).not.toContain("ROUTER-FRAME-SECRET");
    expect(router.hits).toHaveLength(0);
  }, 30_000);
});
