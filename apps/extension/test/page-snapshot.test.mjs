// Снимок и find (W1 A1/A2) в настоящем Chromium: ref у каждого элемента, реестр ref живёт с документом, find ранжирует.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, swOnPage } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["inspectPageInPage", "validateRefsIsolated", "stampRefIsolated"]);

describe("снимок и реестр ref", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  // Реестр ref живёт в изолированном мире расширения — там его и гоняем.
  const snap = async (query = "", cap = 80) => (await page.callIsolated(fns.inspectPageInPage, query, cap)).elements;
  const bySel = (els, s) => els.find((e) => e.selector === s);

  it("ref есть у КАЖДОГО элемента; у поля — type; пароль без name помечен secret, значение — «•••»", async () => {
    await page.open(fixtureUrl("find.html"));
    await page.eval("document.getElementById('pw-noname').value = 'Hunter2!'");
    const els = await snap();
    assert.ok(els.length > 20);
    for (const e of els) assert.match(String(e.ref), /^e\d+_\d+$/u, JSON.stringify(e));
    assert.equal(bySel(els, "#email").type, "email");
    const pw = bySel(els, "#pw-noname");
    assert.equal(pw.type, "password");
    assert.equal(pw.secret, true);
    assert.equal(pw.state.value, "•••");
    assert.ok(!JSON.stringify(els).includes("Hunter2"));
  });

  it("тот же элемент — тот же ref в следующем снимке; ref снимка живы после find", async () => {
    await page.open(fixtureUrl("find.html"));
    const first = await snap();
    const second = await snap();
    assert.equal(bySel(second, "#btn-login").ref, bySel(first, "#btn-login").ref);
    const found = await snap("кнопка войти", 20);
    assert.equal(found[0].ref, bySel(first, "#btn-login").ref, "find дал новый ref живому элементу");
    const r = await page.callIsolated(fns.validateRefsIsolated, first.map((e) => e.ref));
    assert.deepEqual(r.bad, [], "find сбросил ref прежнего снимка");
  });

  it("ref со старой страницы и ref удалённого элемента — ref_stale, а не клик по тёзке", async () => {
    await page.open(fixtureUrl("find.html"));
    const old = await snap();
    const btn = bySel(old, "#btn-login").ref;
    await page.eval("document.getElementById('remember').remove()");
    const gone = await page.callIsolated(fns.stampRefIsolated, bySel(old, "#remember").ref, "n1");
    assert.equal(gone.code, "ref_stale");
    await page.open(fixtureUrl("find.html"));
    await snap(); // новый документ, новый реестр
    const r = await page.callIsolated(fns.stampRefIsolated, btn, "n2");
    assert.equal(r.code, "ref_stale", JSON.stringify(r));
  });
});

describe("find — ранжированный поиск по описанию", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); await page.open(fixtureUrl("find.html")); });
  after(async () => { await page?.close(); });
  const find = async (q) => (await page.callIsolated(fns.inspectPageInPage, q, 20));

  for (const [q, sel] of [
    ["кнопка войти", "#btn-login"],
    ["поле email", "#email"],
    ["галочка запомнить", "#remember"],
    ["ссылка предложения", "#nav-offers"],
    ["нажми кнопку «Войти»", "#btn-login"],
    ["ссылку войти", "#nav-login"],
  ]) {
    it(`«${q}» → первым ${sel}`, async () => {
      const r = await find(q);
      assert.equal(r.elements[0]?.selector, sel, JSON.stringify(r.elements.slice(0, 3).map((e) => [e.selector, e.name, e.score])));
    });
  }

  it("не больше 20 результатов, усечение помечено", async () => {
    const r = await find("в корзину");
    assert.equal(r.elements.length, 20);
    assert.equal(r.truncated, true);
  });

  it("service worker: find по всем фреймам — до 20 лучших, без служебного score", async () => {
    const { env, calls } = swOnPage(page);
    const r = await env.tabInspect("", "кнопка войти", 80, 1);
    assert.deepEqual([...calls[0].args], ["кнопка войти", 20]); // массив из vm — копия в наш realm
    assert.equal(r.elements[0].selector, "#btn-login");
    assert.ok(r.elements.length <= 20);
    assert.ok(r.elements.every((e) => e.score === undefined && typeof e.idx === "number"));
  });
});
