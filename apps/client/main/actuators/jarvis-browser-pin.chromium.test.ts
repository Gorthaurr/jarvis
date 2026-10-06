/**
 * B-14 (DNS rebinding): пиннинг-прокси невидимого браузера — НАСТОЯЩИЙ JarvisBrowser в настоящем Chromium. Гард
 * навигации судит ответ DNS, но подключался Chrome сам, со своим резолвом: DNS атакующего (TTL 0) отвечал гарду
 * публичным адресом, а Chrome — 127.0.0.1. Теперь Chrome ходит только через прокси, и суд идёт при ПОДКЛЮЧЕНИИ.
 *
 * «DNS» стенда — rebind*-имена: первый ответ публичный, дальше 127.0.0.1. Профиль без предподключения Chrome — порядок
 * детерминирован: гард спрашивает первым (публичный → пускает), прокси — вторым (127.0.0.1 → отказ). Факты — журнал
 * «роутера» (ни одного запроса), честная ошибка web_open/web_read и журнал прокси.
 *
 * Реверт-проверки (из копии): Chrome без `--proxy-server` (сам резолвит; host-resolver стенда → 127.0.0.1) → «роутер»
 * получает запросы — rebinding и подресурсы красные; без `<-loopback>` литерал 127.0.0.1 идёт мимо прокси — подресурс-
 * литерал красный; блок прокси не сопоставлен с переходом (`proxyBlocked` → false) → web_open отдаёт страницу ошибки
 * Chrome вместо честного отказа — rebinding красный.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) } }));

import { type Fixture, PUBLIC_HOST, findChrome, fixture, launchJarvisBrowser, rebindAsked } from "../test-support/jb-fixtures.js";
import type { JarvisBrowser } from "./jarvis-browser.js";
import type { PinProxy } from "./jarvis-browser-proxy.js";

const chrome = findChrome();
const online = await dnsLookup("example.com").then((a) => !a.address.startsWith("127."), () => false);

describe.skipIf(!chrome)("B-14 (rebinding): невидимый браузер подключается только к адресу, проверенному при подключении", () => {
  let router: Fixture;
  let shop: Fixture;
  let jb: JarvisBrowser;
  let dispose: () => Promise<void>;
  const at = (host: string, path = "/secret") => `http://${host}:${router.port}${path}`;
  const proxyBlocked = () => (jb as unknown as { proxy: PinProxy }).proxy.blocked.map((b) => b.host);

  beforeAll(async () => {
    router = await fixture({ "/secret": "<h1>ROUTER-SECRET admin:hunter2</h1>", "/img": "x", "/api": "ROUTER-API" });
    shop = await fixture({
      "/": `<h1>SHOP</h1><a id="l" href="${at("rebind2.jb.example")}">скидки</a>`,
      "/subres":
        `<h1>SHOP-SUB</h1><img src="${at("evil.jb.example", "/img")}"><img src="${at("127.0.0.1", "/img")}">` +
        `<script>fetch(${JSON.stringify(at("evil.jb.example", "/api"))}, { mode: "no-cors" }).catch(() => 0)</script>`,
    });
    ({ jb, dispose } = launchJarvisBrowser(chrome!, { noPreconnect: true }));
  }, 60_000);

  afterAll(async () => {
    await dispose?.();
    await router?.close();
    await shop?.close();
  });

  const shopUrl = (p: string) => `http://${PUBLIC_HOST}:${shop.port}${p}`;
  const openErr = (url: string) => jb.open(url).then((p) => `OK ${JSON.stringify(p)}`, (e: Error) => `ERR ${e.message}`);

  it("web_open: гарду DNS ответил публичным, подключению — 127.0.0.1 → отказ прокси, честная ошибка, «роутер» без запросов", async () => {
    expect((await jb.open(shopUrl("/"))).text).toContain("SHOP"); // контроль: обычный путь через прокси жив
    const r = await openErr(at("rebind1.jb.example"));
    expect(r).toMatch(/^ERR .*внутренний адрес/u);
    expect(r).not.toContain("ROUTER-SECRET");
    expect(r).not.toContain("rebind1.jb.example"); // имя задаёт страница — в доверенный текст не попадает (B-14)
    expect(rebindAsked.get("rebind1.jb.example")).toBe(2); // суд гарда (публичный) + суд подключения (127.0.0.1)
    expect(proxyBlocked()).toContain("rebind1.jb.example");
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("клик по ссылке на rebinding-имя → web_read честная ошибка, секрета нет, «роутер» без запросов", async () => {
    await jb.open(shopUrl("/"));
    await jb.act("click", { selector: "#l" }).catch(() => "act-error");
    await new Promise((r) => setTimeout(r, 800));
    const read = await jb.read().then((p) => JSON.stringify(p), (e: Error) => `ERR ${e.message}`);
    expect(read).toMatch(/^ERR .*внутренний адрес/u);
    expect(read).not.toContain("ROUTER-SECRET");
    expect(proxyBlocked()).toContain("rebind2.jb.example");
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("подресурсы (img, fetch) на имя → 127.0.0.1 и на литерал 127.0.0.1 режет прокси; страница читается без ложной ошибки", async () => {
    const before = proxyBlocked().length;
    const page = await jb.open(shopUrl("/subres"));
    expect(page.text).toContain("SHOP-SUB");
    await new Promise((r) => setTimeout(r, 800));
    expect(new Set(proxyBlocked().slice(before))).toEqual(new Set(["evil.jb.example", "127.0.0.1"]));
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  // Настоящий интернет через прокси: TLS в CONNECT-туннеле и системный DNS (без таблиц стенда). Нет сети — пропуск.
  it.skipIf(!online)("живьём: https://example.com открывается через прокси пиннинга", async () => {
    const page = await jb.open("https://example.com/");
    // Текст чужого сайта меняется. Сломанный TLS даёт chrome-error:// вместо URL назначения.
    expect(page.url).toBe("https://example.com/");
    expect(page.title).toMatch(/example/iu);
    expect(page.text.trim().length).toBeGreaterThan(0);
  }, 30_000);
});
