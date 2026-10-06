/**
 * ЖИВОЙ контур браузерных рук: лаб-сервер (настоящий процесс) <- /ext <- лаб-копия расширения в headless-Chrome
 * (временный профиль) -> фикстуры. Инструменты идут через НАСТОЯЩИЙ dispatchTool сервера. Проверка — по ФАКТУ на стороне
 * страницы (журнал фикстур, DOM по CDP), а не по словам инструмента. Нет Chromium — пропуск с причиной в имени набора.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { JARVIS_WEB_HANDS_EXT_ID } from "../../../apps/server/src/gateway/ext-id.js";
import { repoRoot } from "../lib/deps.js";
import { type BrowserLab, LAB_HOSTS, startBrowserLab } from "./browser-lab.js";
import { ARTICLE_MARKER } from "./fixture-pages.js";
import { liveSuite, openAndInspect, pageHits } from "./test-support.js";

const PROD_DIST = repoRoot("apps/extension/dist/background.js");
const sha = (): string => (existsSync(PROD_DIST) ? createHash("sha256").update(readFileSync(PROD_DIST)).digest("hex") : "нет файла");

liveSuite("браузерная лаборатория: контур сервер + расширение + Chrome", () => {
  let lab: BrowserLab;
  const distBefore = sha();
  const click = (label: string, confirm?: "yes" | "no" | "expire" | "undelivered") => lab.tool("browser_act", { intent: "click", ref: `$ref:${label}` }, { confirm });

  beforeAll(async () => {
    lab = await startBrowserLab();
  }, 120_000);
  afterAll(async () => void (await lab?.close()), 60_000);
  beforeEach(() => lab.reset(), 30_000);

  it("изоляция: порт лаборатории, лаб-копия на этот порт, ID расширения = пиннинг /ext, dist продукта не тронут", async () => {
    expect(lab.server.port).toBeGreaterThanOrEqual(8811);
    expect(lab.server.port).toBeLessThanOrEqual(8899);
    expect(lab.ext.wsUrl).toBe(`ws://127.0.0.1:${lab.server.port}/ext`);
    expect(lab.ext.extId).toBe(JARVIS_WEB_HANDS_EXT_ID);
    expect((await lab.state()).ext.connected).toBe(true);
    expect(lab.server.logTail(80)).toContain("расширение подключено");
    expect(lab.browser.alive()).toBe(true);
    expect(lab.browser.chrome.path).not.toBe("");
    expect(sha()).toBe(distBefore);
  });

  it("open -> read: браузер РЕАЛЬНО сходил на страницу, текст пришёл недоверенным блоком", async () => {
    const opened = await lab.tool("browser_open", { url: lab.url("/article") });
    expect(opened.result.text).toBe(`Открыл ${lab.url("/article")}.`);
    const read = (await lab.tool("browser_read", {})).result.text;
    expect(pageHits(lab)).toContainEqual({ path: "/article", host: LAB_HOSTS.site, status: 200 });
    expect(read).toContain('<untrusted_content source="вкладка http://site.lab.test/article">');
    expect(read).toContain("# Длинная статья стенда");
    expect(read).toContain("Абзац 1.");
  });

  it("read{selectorIntent} выделяет глубокий абзац, а не льёт весь дамп", async () => {
    await lab.tool("browser_open", { url: lab.url("/article") });
    const text = (await lab.tool("browser_read", { selectorIntent: "МАРКЕР-ГЛУБОКИЙ" })).result.text;
    expect(text).toContain(ARTICLE_MARKER);
    expect(text).not.toContain("Абзац 12.");
    expect(text).not.toContain("ничего не выделил");
  });

  it("inspect{query} находит кнопку по слову и даёт ref", async () => {
    await lab.tool("browser_open", { url: lab.url("/checkout", LAB_HOSTS.shop) });
    const r = await lab.tool("browser_inspect", { query: "Оплатить" });
    expect(r.result.text).toContain('"name":"Оплатить заказ"');
    expect(r.result.text).toMatch(/"ref":"e\d+_\d+"/u);
  });

  it("безопасный клик доходит до страницы: событие есть, DOM изменился, вопросов нет", async () => {
    await openAndInspect(lab, "/checkout", LAB_HOSTS.shop);
    const r = await click("Показать детали");
    expect(r.result.text).toContain('"changed":true');
    expect(r.questions).toHaveLength(0);
    expect(r.result.flags.declined).toBeUndefined();
    expect(lab.fixtures.events("details_shown")).toHaveLength(1);
    expect(await lab.evalPage("document.getElementById('info').hidden", "shop.lab.test")).toBe(false);
  });

  it("§14 страничный гард на обычном хосте: без «да» кнопка НЕ нажата, вопрос задан один раз", async () => {
    await openAndInspect(lab, "/checkout", LAB_HOSTS.shop);
    const r = await click("Оплатить заказ", "no");
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatchObject({ kind: "irreversible", answer: "no", outcome: "denied" });
    expect(r.questions[0]?.summary).toContain("клик «Оплатить заказ» на shop.lab.test");
    expect(r.questions[0]?.summary).toContain("(сайт)");
    expect(r.result.flags.declined).toBe(true);
    expect(lab.fixtures.events("pay")).toHaveLength(0);
  });

  it("тот же клик с «да» нажимает РОВНО один раз (иначе «нет» ничем не отличить от сломанных рук)", async () => {
    await openAndInspect(lab, "/checkout", LAB_HOSTS.shop);
    const r = await click("Оплатить заказ", "yes");
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]).toMatchObject({ answer: "yes", outcome: "approved" });
    expect(r.result.flags.declined).toBeUndefined();
    expect(lab.fixtures.events("pay")).toMatchObject([{ kind: "pay", host: LAB_HOSTS.shop }]);
  });

  it("§14 серверный гейт опасного хоста (банк): спросил ДО расширения, «нет» — не нажато, «да» — нажато на этом хосте", async () => {
    await openAndInspect(lab, "/checkout", LAB_HOSTS.bank);
    const denied = await click("Оплатить заказ", "no");
    expect(denied.questions[0]?.summary).toContain("(банк)");
    expect(denied.result.flags.declined).toBe(true);
    expect(lab.fixtures.events("pay")).toHaveLength(0);
    const approved = await click("Оплатить заказ", "yes");
    expect(approved.questions).toHaveLength(1);
    expect(lab.fixtures.events("pay")).toMatchObject([{ host: LAB_HOSTS.bank }]);
  });

  it.each(["expire", "undelivered"] as const)("исход вопроса «%s» тоже не нажимает и помечен declined", async (outcome) => {
    await openAndInspect(lab, "/checkout", LAB_HOSTS.shop);
    const r = await click("Оплатить заказ", outcome);
    expect(r.questions[0]?.outcome).toBe(outcome === "expire" ? "expired" : "undelivered");
    expect(r.result.flags.declined).toBe(true);
    expect(lab.fixtures.events("pay")).toHaveLength(0);
  });
});
