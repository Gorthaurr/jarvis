// Глаза и руки форм расширения (inspect/select/read) в настоящем Chromium. Запуск: node --test apps/extension/test/
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["inspectPageInPage", "robustClickMain", "pageActInPage", "readPageInPage", "actByRefIsolated"]);

describe("inspect на обычной странице", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); await page.open(fixtureUrl("plain.html")); });
  after(async () => { await page?.close(); });

  it("одноимённые поля в двух формах получают РАЗНЫЕ селекторы, каждый — ровно на своё поле", async () => {
    const els = (await page.call(fns.inspectPageInPage, "", 80, false)).elements.filter((e) => e.tag === "input" && e.label === "Город");
    assert.equal(els.length, 2, JSON.stringify(els));
    const forms = [];
    for (const { selector: s } of els) {
      assert.equal(await page.eval(`document.querySelectorAll(${JSON.stringify(s)}).length`), 1, s);
      forms.push(await page.eval(`document.querySelector(${JSON.stringify(s)}).form.id`));
    }
    assert.deepEqual(forms, ["f1", "f2"]);
  });
});

describe("inspect/select/read на тесте Moodle", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); await page.open(fixtureUrl("moodle-attempt.html")); });
  after(async () => { await page?.close(); });

  const snap = async (refMode = false) => (await page.call(fns.inspectPageInPage, "", 80, refMode)).elements;

  it("у вариантов одного вопроса РАЗНЫЕ селекторы, и каждый указывает ровно на свой вариант", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const els = await snap();
    const sels = els.filter((e) => e.tag === "input" && /q145678:1_answer|q145678\\:1_answer/.test(e.selector)).map((e) => e.selector);
    assert.equal(sels.length, 3, `ожидал 3 варианта, а снимок дал: ${JSON.stringify(sels)}`);
    assert.equal(new Set(sels).size, 3);
    for (const [i, s] of sels.entries()) {
      assert.equal(await page.eval(`document.querySelectorAll(${JSON.stringify(s)}).length`), 1, s);
      assert.equal(await page.eval(`document.querySelector(${JSON.stringify(s)}).id`), `q145678:1_answer${i}`);
    }
  });

  it("в обычном (не ref) снимке у варианта видна его подпись, а не value «0/1/2»", async () => {
    const els = await snap();
    const labels = els.filter((e) => e.tag === "input" && e.label).map((e) => e.label);
    assert.ok(labels.some((l) => /Париж/u.test(l)), JSON.stringify(labels));
  });

  it("клик по селектору из снимка выбирает именно третий вариант", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const s = (await snap()).find((e) => e.tag === "input" && e.label && /Париж/u.test(e.label)).selector;
    await page.call(fns.robustClickMain, { selector: s });
    assert.equal(await page.eval("document.getElementById('q145678:1_answer2').checked"), true);
  });

  it("галочка с hidden-двойником: селектор бьёт в checkbox, а не в скрытый input", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const el = (await snap()).find((e) => e.tag === "input" && e.label && /(^|\s)7$/u.test(e.label.trim()));
    assert.ok(el, "нет галочки «7» в снимке");
    await page.call(fns.robustClickMain, { selector: el.selector });
    assert.equal(await page.eval("document.getElementById('q145678:2_choice1').checked"), true);
  });

  it("у выпадающего списка снимок показывает выбранное и варианты", async () => {
    const sel = (await snap()).find((e) => e.tag === "select");
    assert.ok(sel);
    assert.equal(sel.state.value, "Выберите...");
    assert.deepEqual(sel.state.options, ["Выберите...", "Мадрид", "Берлин"]);
  });

  it("intent select ставит вариант по тексту и шлёт change", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    await page.eval("window.__chg = 0; document.querySelector('select').addEventListener('change', () => window.__chg++)");
    const r = await page.call(fns.pageActInPage, "select", { selector: 'select[name="q145678:3_sub0"]', option: "берлин" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value, "Берлин");
    assert.equal(await page.eval("document.querySelector('select').value"), "2");
    assert.equal(await page.eval("window.__chg"), 1);
  });

  it("intent select: несуществующий вариант — честный провал со списком вариантов", async () => {
    const r = await page.call(fns.pageActInPage, "select", { selector: 'select[name="q145678:3_sub1"]', option: "Лиссабон" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Мадрид/u);
  });

  it("select по ref (ref-режим): вариант ставится по тексту, readback — выбранный текст", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const els = (await page.call(fns.inspectPageInPage, "", 80, true)).elements;
    const sel = els.find((e) => e.role === "select");
    assert.ok(sel?.ref, JSON.stringify(els.map((e) => e.role)));
    const r = await page.call(fns.actByRefIsolated, sel.ref, "select", { option: "Мадрид" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value, "Мадрид");
    assert.equal(await page.eval("document.querySelector('select').value"), "1");
  });

  it("чтение отдаёт формулу MathJax исходным TeX", async () => {
    const r = await page.call(fns.readPageInPage, "");
    assert.match(r.text, /\\frac\{a\}\{b\}/u);
  });
});
