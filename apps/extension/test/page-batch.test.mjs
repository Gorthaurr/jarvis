// browser_batch (W1): шаги по ref | selector | text, стоп на первом провале с кодом — service worker поверх страницы.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, swOnPage } from "./cdp-harness.mjs";

describe("берст шагов", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });

  it("форма за один вызов: selector, подпись, ref вперемешку — все шаги выполнены", async () => {
    await page.open(fixtureUrl("form.html"));
    const { env } = swOnPage(page);
    const snap = await env.tabInspect("", "", 200, 1);
    const q = snap.elements.find((e) => e.selector === "#q").ref;
    const r = await env.tabBatch("", [
      { selector: "#name", intent: "set", params: { value: "Иван" } },
      { text: "Получать новости", intent: "set", params: { checked: true } },
      { ref: q, intent: "type", params: { text: "кот", enter: true } },
    ], 1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.done, 3);
    assert.equal(await page.eval("document.getElementById('name').value"), "Иван");
    assert.equal(await page.eval("document.getElementById('news').checked"), true);
    assert.equal(await page.eval("window.__c.search"), 1);
    assert.equal(r.results[2].result.submitted, true);
  });

  it("type с подписью цели на верхнем уровне шага: text — поле, params.text — что печатать", async () => {
    await page.open(fixtureUrl("form.html"));
    const { env } = swOnPage(page);
    const r = await env.tabBatch("", [{ text: "Поиск", intent: "type", params: { text: "Пётр" } }], 1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('q').value"), "Пётр");
    assert.equal(await page.eval("document.getElementById('name').value"), "Старое", "текст ушёл не в то поле");
  });

  // Р2 ext-bypass-batch-submit-nav: GET-форма уводит страницу по Enter без navigated — шаг 2 бил бы по НОВОЙ странице.
  it("type+enter в не последнем шаге увёл страницу формой — стоп с кодом submitted, шаг 2 не исполнен", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval(`document.body.insertAdjacentHTML('afterbegin','<form id=nav action="form.html" method=get><input id=qq name=qq type=text></form>'); 1`);
    const { env } = swOnPage(page);
    const r = await env.tabBatch("", [{ intent: "type", selector: "#qq", params: { text: "x", enter: true } }, { intent: "type", selector: "#q", params: { text: "SECOND" } }], 1);
    assert.deepEqual([r.ok, r.code, r.done, r.stoppedAt], [false, "submitted", 1, 0], JSON.stringify({ ...r, results: undefined }));
    await new Promise((res) => setTimeout(res, 800));
    assert.match(await page.eval("location.href"), /form\.html\?qq=x$/u);
    assert.equal(await page.eval("document.getElementById('q').value"), "", "шаг 2 напечатал на новой странице");
  });

  it("шаг в поле пароля — стоп на нём, код secret_field полем, выполнено 1 из 2", async () => {
    await page.open(fixtureUrl("form.html"));
    const { env } = swOnPage(page);
    const r = await env.tabBatch("", [
      { selector: "#name", intent: "set", params: { value: "Анна" } },
      { selector: "#pw-noname", intent: "type", params: { text: "hunter2" } },
    ], 1);
    assert.deepEqual([r.ok, r.done, r.stoppedAt, r.code], [false, 1, 1, "secret_field"]);
    assert.equal(await page.eval("document.getElementById('pw-noname').value"), "");
  });
});
