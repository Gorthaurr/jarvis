// Клик B-1 (React-обёртка, router Link, свайпер), сигнал изменения B-7 и hover — в настоящем Chromium, мир страницы.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, swOnPage } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["robustClickMain"]);

describe("B-1: клик на React-страницах — ровно одно действие", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const click = (p) => page.call(fns.robustClickMain, p);

  it("ссылка внутри React-обёртки переходит, onClick обёртки — ровно один раз", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#plain" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("location.hash"), "#target");
    assert.equal(await page.eval("window.__c.wrap"), 1);
  });

  it("react-router Link: один переход (pushState), без ухода по href", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ text: "Профиль" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("window.__c.nav"), 1);
    assert.equal(await page.eval("location.hash"), "#profile");
    assert.match(String(r.navigated), /#profile$/u);
  });

  it("свайпер глушит клик в capture-фазе → React-onClick самого слайда, ровно один раз", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#slide" });
    assert.equal(r.method, "react");
    assert.equal(await page.eval("window.__c.slide"), 1);
  });

  it("клик не дошёл, пропа у элемента нет — onClick ПРЕДКА (карточки) не зовём, честно reached:false", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#inner" });
    assert.equal(await page.eval("window.__c.card"), 0);
    assert.equal(r.reached, false);
    assert.equal(r.changed, false);
  });

  it("встряхивание по React-кнопке без эффекта: onClick не вызывается второй раз, честный no_effect", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#rbtn", expectChange: true });
    assert.equal(r.code, "no_effect");
    assert.equal(await page.eval("window.__c.rbtn"), 1);
  });

  it("клик дошёл до React-кнопки — onClick срабатывает ровно один раз (без второго вызова пропа)", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#rbtn" });
    assert.equal(r.method, "pointer");
    assert.equal(await page.eval("window.__c.rbtn"), 1);
  });
});

describe("B-7: changed — изменения всего документа, без шума", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const click = (p) => page.call(fns.robustClickMain, p);

  it("счётчик «Товаров 1→2» — changed:true (цифры не вырезаются)", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#add" });
    assert.equal(await page.eval("document.getElementById('cnt').textContent"), "Товаров: 2");
    assert.equal(r.changed, true);
  });

  it("всплывашка-портал вне main (без роли диалога) — changed:true", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#open-modal" });
    assert.equal(r.changed, true);
  });

  it("часы и бегущая строка меняются сами — клик по кнопке без действия даёт changed:false", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await click({ selector: "#inert" });
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
  });
});

describe("hover и ref после повторного снимка (service worker → страница)", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });

  it("страница: hover не судится гардом, даже если подпись похожа на коммит", async () => {
    await page.open(fixtureUrl("react.html"));
    const r = await page.call(fns.robustClickMain, { text: "Меню", action: "hover", guard: "меню" });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it("hover раскрывает подменю: changed:true, гард не применяется", async () => {
    await page.open(fixtureUrl("react.html"));
    const { env, calls } = swOnPage(page);
    const r = await env.tabAct("", "hover", { text: "Меню", guard: "меню" }, 1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, true);
    assert.equal(await page.eval("document.getElementById('sub').hidden"), false);
    const arg = calls.find((c) => c.func.name === "robustClickMain").args[0];
    assert.equal(arg.action, "hover");
    assert.equal(arg.guard, undefined);
  });

  it("два полных снимка подряд → клик по ref из ПЕРВОГО работает", async () => {
    await page.open(fixtureUrl("react.html"));
    const { env } = swOnPage(page);
    const first = await env.tabInspect("", "", 80, 1);
    await env.tabInspect("", "", 80, 1);
    const ref = first.elements.find((e) => e.selector === "#rbtn").ref;
    const r = await env.tabAct("", "click", { ref }, 1);
    assert.equal(r.ok, true);
    assert.equal(await page.eval("window.__c.rbtn"), 1);
  });
});
