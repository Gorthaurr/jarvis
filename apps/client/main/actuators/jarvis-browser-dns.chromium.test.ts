/**
 * B-14 (DNS): живой факт 27.09 — `localtest.me`/`127.0.0.1.nip.io` проходили гард навигации по ИМЕНИ, и невидимый
 * Chrome Джарвиса реально ходил на 127.0.0.1. НАСТОЯЩИЙ JarvisBrowser в настоящем Chromium: Chrome ведёт любое
 * `*.jb.example` на 127.0.0.1 («роутер»), а гард судит по «DNS» стенда (fixtureLookup): evil → 127.0.0.1, mixed →
 * публичный + 127.0.0.1, slow → 127.0.0.1 через 1,5 с, nx — не разрешается. Факт — журнал «роутера»: НИ ОДНОГО запроса.
 * Последний блок — настоящий публичный DNS (localtest.me), без таблиц; нет сети — пропуск.
 *
 * Реверт-проверка (из копии): гард судит только имя (без checkHostPublic) → «роутер» получает запросы → красный;
 * «не разрешилось» пропускается → nx доходит до «роутера» → красный. Rebinding здесь — с предподключением Chrome, как в
 * бою (порядок «гард/прокси» плавает); детерминированный разбор суда прокси — jarvis-browser-pin.chromium.test.ts.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) } }));

import { type Fixture, PUBLIC_HOST, findChrome, fixture, launchJarvisBrowser } from "../test-support/jb-fixtures.js";
import type { JarvisBrowser } from "./jarvis-browser.js";

const chrome = findChrome();
const liveLoopback = async (name: string) => dnsLookup(name).then((a) => a.address === "127.0.0.1", () => false);
const live = { localtest: await liveLoopback("localtest.me"), nip: await liveLoopback("127.0.0.1.nip.io") };

describe.skipIf(!chrome)("B-14 (DNS): имя, указывающее внутрь, не уводит невидимый браузер в локальную сеть", () => {
  let router: Fixture;
  let shop: Fixture;
  let jb: JarvisBrowser;
  let dispose: () => Promise<void>;
  const at = (host: string, path = "/secret") => `http://${host}:${router.port}${path}`;

  beforeAll(async () => {
    router = await fixture({ "/secret": "<h1>ROUTER-SECRET admin:hunter2</h1>", "/frame": "ROUTER-FRAME-SECRET" });
    shop = await fixture({
      "/": `<h1>SHOP</h1><a id="l" href="${at("evil.jb.example")}">скидки</a>`,
      "/framed": `<h1>SHOP-FRAMED</h1><iframe src="${at("evil.jb.example", "/frame")}"></iframe>`,
      "/redir": (_q, _b, res) => void res.writeHead(302, { location: at("evil.jb.example") }).end(),
      "/nx-frame": `<h1>NX-FRAME</h1><button id="f" onclick="document.body.insertAdjacentHTML('beforeend', '<iframe src=&quot;${at("nx.jb.example", "/ad")}&quot;></iframe>')">баннер</button>`,
      "/nx-link": `<h1>NX-LINK</h1><a id="n" href="${at("nx.jb.example", "/x")}">мёртвая ссылка</a>`,
    });
    ({ jb, dispose } = launchJarvisBrowser(chrome!));
  }, 60_000);

  afterAll(async () => {
    await dispose?.();
    await router?.close();
    await shop?.close();
  });

  const shopUrl = (p: string) => `http://${PUBLIC_HOST}:${shop.port}${p}`;
  const openErr = (url: string) => jb.open(url).then((p) => `OK ${JSON.stringify(p)}`, (e: Error) => `ERR ${e.message}`);

  it("контроль: публичное имя открывается (гард по DNS не ломает обычный путь)", async () => {
    expect((await jb.open(shopUrl("/"))).text).toContain("SHOP");
  }, 30_000);

  it("web_open на имя → 127.0.0.1 и на мультизапись «публичный + 127.0.0.1» → честная ошибка, «роутер» без запросов", async () => {
    for (const host of ["evil.jb.example", "mixed.jb.example"]) {
      const r = await openErr(at(host));
      expect(r, host).toMatch(/^ERR .*внутренний адрес/u);
      expect(r).not.toContain("ROUTER-SECRET");
      expect(r).not.toContain(host); // имя задаёт страница — в доверенный текст ошибки не попадает (инъекция)
    }
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("медленный DNS (1,5 с) с внутренним ответом: open ждёт вердикт и не отдаёт прежнюю страницу", async () => {
    await jb.open(shopUrl("/"));
    const r = await openErr(at("slow.jb.example"));
    expect(r).toMatch(/^ERR .*внутренний адрес/u);
    expect(r).not.toContain("SHOP");
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("DNS rebinding (первый ответ публичный, дальше 127.0.0.1) с предподключением Chrome → честная ошибка, запросов нет", async () => {
    const r = await openErr(at("rebind-live.jb.example"));
    expect(r).toMatch(/^ERR .*внутренний адрес/u);
    expect(r).not.toContain("ROUTER-SECRET");
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("имя не разрешилось → отказ (fail-closed) с честным текстом про DNS, запросов нет", async () => {
    expect(await openErr(at("nx.jb.example"))).toMatch(/^ERR .*проверку DNS/u);
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("302 на имя → 127.0.0.1, клик по ссылке на него, iframe с ним → запросов нет; страница-носитель читается", async () => {
    expect(await openErr(shopUrl("/redir"))).toMatch(/^ERR .*внутренний адрес/u);
    await jb.open(shopUrl("/"));
    await jb.act("click", { selector: "#l" }).catch(() => "act-error");
    await new Promise((r) => setTimeout(r, 600));
    const read = await jb.read().then((p) => JSON.stringify(p), (e: Error) => `ERR ${e.message}`);
    expect(read).toMatch(/ERR .*внутренний адрес/u);
    const framed = await jb.open(shopUrl("/framed"));
    expect(framed.text).toContain("SHOP-FRAMED");
    expect(JSON.stringify(framed)).not.toContain("ROUTER-FRAME-SECRET");
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("клик вставил iframe с мёртвым именем → действие НЕ помечено «переход заблокирован» (не провал действия)", async () => {
    await jb.open(shopUrl("/nx-frame"));
    const out = await jb.act("click", { selector: "#f" });
    await new Promise((r) => setTimeout(r, 400));
    expect(out.blockedNav).toBeUndefined();
    expect((await jb.read()).text).toContain("NX-FRAME");
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it("клик по ссылке на мёртвое имя (главный фрейм) → web_read честно про DNS, не «внутренний адрес»", async () => {
    await jb.open(shopUrl("/nx-link"));
    await jb.act("click", { selector: "#n" }).catch(() => "act-error");
    await new Promise((r) => setTimeout(r, 600));
    const read = await jb.read().then((p) => `OK ${JSON.stringify(p)}`, (e: Error) => `ERR ${e.message}`);
    expect(read).toMatch(/^ERR .*проверку DNS/u);
    expect(read).not.toMatch(/внутренний адрес/u);
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  // Настоящий публичный DNS — ровно адреса из живой проверки 27.09 (Chrome резолвит их сам, мимо таблиц стенда).
  it.skipIf(!live.localtest)("живьём: http://localtest.me:<порт>/ → честная ошибка, «роутер» без запросов", async () => {
    expect(await openErr(at("localtest.me"))).toMatch(/^ERR .*внутренний адрес/u);
    expect(router.hits).toHaveLength(0);
  }, 30_000);

  it.skipIf(!live.nip)("живьём: http://127.0.0.1.nip.io:<порт>/ → честная ошибка, «роутер» без запросов", async () => {
    expect(await openErr(at("127.0.0.1.nip.io"))).toMatch(/^ERR .*внутренний адрес/u);
    expect(router.hits).toHaveLength(0);
  }, 30_000);
});
