// Действия над элементом (W1 A3/A4): set = form_input, key, scroll_to, Enter, §0 — в настоящем Chromium, в изолированном
// мире расширения (как executeScript), цель по ref из снимка, selector или подписи.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, serverGuardSource, swOnPage } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["inspectPageInPage", "elementActIsolated", "pageActInPage"]);
const GUARD = serverGuardSource();

describe("set / key / scroll_to / Enter", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const act = (intent, params, ref = null) => page.callIsolated(fns.elementActIsolated, ref, intent, params);
  const refOf = async (selector) => (await page.callIsolated(fns.inspectPageInPage, "", 200)).elements.find((e) => e.selector === selector)?.ref;

  it("set в поле: нативный сеттер, readback и changed", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("set", { value: "Анна" }, await refOf("#name"));
    assert.deepEqual({ ok: r.ok, value: r.value, changed: r.changed }, { ok: true, value: "Анна", changed: true });
    assert.equal(await page.eval("document.getElementById('name').value"), "Анна");
  });

  it("set галочки: кликает только если состояние другое — повторный set её НЕ снимает", async () => {
    await page.open(fixtureUrl("form.html"));
    const ref = await refOf("#news");
    const a = await act("set", { checked: true }, ref);
    const b = await act("set", { checked: true }, ref);
    assert.deepEqual([a.checked, a.changed, b.checked, b.changed], [true, true, true, false]);
    assert.equal(await page.eval("document.getElementById('news').checked"), true);
    const c = await act("set", { checked: false }, ref);
    assert.equal(c.checked, false);
    assert.equal(await page.eval("document.getElementById('news').checked"), false);
  });

  it("set переключателя role=switch (aria-checked) по подписи", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("set", { text: "Тёмная тема", checked: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('dark').getAttribute('aria-checked')"), "true");
    assert.equal((await act("set", { text: "Тёмная тема", checked: true })).changed, false);
  });

  it("set списка: value = текст пункта", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("set", { selector: "#city", value: "Казань" });
    assert.equal(r.value, "Казань");
    assert.equal(await page.eval("document.getElementById('city').value"), "Казань");
  });

  it("contenteditable: разметка редактора цела, текст заменён, ровно одно событие input", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("set", { selector: "#ed", value: "Новый текст" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("document.querySelector('#ed p[data-b]')?.innerText"), "Новый текст");
    assert.equal(await page.eval("document.getElementById('ed').innerText.trim()"), "Новый текст");
    assert.equal(await page.eval("window.__c.edInput"), 1);
  });

  it("key: Escape и Ctrl+A доходят до цели, ответ честно говорит о синтетике", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("key", { selector: "#name", combo: "Escape" });
    assert.equal(r.ok, true);
    assert.equal(r.sent, "Escape");
    assert.match(r.note, /синтетическ/u);
    await act("key", { selector: "#name", combo: "Ctrl+A" });
    assert.deepEqual(await page.eval("window.__c.keys"), ["Escape@name", "Ctrl+a@name"]);
  });

  it("key Enter в поле поиска: submitted:true и форма ушла один раз", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("key", { selector: "#q", combo: "Enter" });
    assert.equal(r.submitted, true);
    assert.equal(await page.eval("window.__c.search"), 1);
  });

  it("страница отменила Enter (keydown.preventDefault) — форму не отправляем, как и браузер", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("type", { selector: "#nope", text: "кот", enter: true });
    assert.equal(r.submitted, true); // жест Enter был
    assert.equal(await page.eval("window.__c.blocked"), 0);
  });

  it("type + enter: ввод, submitted:true, форма ушла один раз", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("type", { selector: "#q", text: "котики", enter: true });
    assert.deepEqual([r.ok, r.value, r.submitted], [true, "котики", true]);
    assert.equal(await page.eval("window.__c.search"), 1);
  });

  it("type по селектору обёртки (формы) — в её поле; обёртка с полем пароля — отказ §0", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("type", { selector: "#search", text: "котики" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('q').value"), "котики");
    await page.eval("document.getElementById('blocked').insertAdjacentHTML('afterbegin', '<input type=password id=pw2>')");
    const s = await act("type", { selector: "#blocked", text: "hunter2" });
    assert.equal(s.code, "secret_field");
  });

  it("scroll_to: элемент ниже сгиба оказывается во вьюпорте", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("scroll_to", { text: "Кнопка внизу" });
    assert.equal(r.inViewport, true);
    assert.ok((await page.eval("scrollY")) > 1000);
  });

  it("гард §14 на Enter без фокуса: текст страницы («Отправить отзыв…») не делает Enter в пустоту коммитом", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.body.insertAdjacentHTML('afterbegin', '<p>Отправить отзыв можно ниже</p>'); document.activeElement && document.activeElement.blur()");
    const r = await act("key", { combo: "Enter", guard: GUARD });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it("гард §14 на Enter: кнопка формы «Отправить» → commit_confirm, поле не тронуто; после одобрения — уходит", async () => {
    await page.open(fixtureUrl("form.html"));
    const no = await act("type", { selector: "#msg", text: "привет", enter: true, guard: GUARD });
    assert.equal(no.code, "commit_confirm");
    assert.equal(no.label, "Отправить");
    assert.equal(await page.eval("document.getElementById('msg').value"), "");
    const yes = await act("type", { selector: "#msg", text: "привет", enter: true, guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    assert.equal(yes.ok, true);
    assert.equal(await page.eval("window.__c.guarded"), 1);
  });
});

describe("§0: страница не печатает в секретное поле (B-3)", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const act = (intent, params, ref = null) => page.callIsolated(fns.elementActIsolated, ref, intent, params);

  for (const sel of ["#pw-noname", "#pw-shown", "#card"]) {
    it(`type и set в ${sel} → secret_field, значение не меняется`, async () => {
      await page.open(fixtureUrl("form.html"));
      const before = await page.eval(`document.querySelector(${JSON.stringify(sel)}).value`);
      const ref = (await page.callIsolated(fns.inspectPageInPage, "", 200)).elements.find((e) => e.selector === sel)?.ref;
      for (const [intent, p, r] of [["type", { text: "hunter2" }, ref], ["set", { value: "hunter2" }, ref], ["type", { selector: sel, text: "hunter2" }, null]]) {
        const res = await act(intent, p, r);
        assert.equal(res.code, "secret_field", `${intent}: ${JSON.stringify(res)}`);
        assert.match(res.error, /^secret_field:/u);
      }
      assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel)}).value`), before);
    });
  }

  it("type без цели, когда фокус в поле пароля, — тоже отказ", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.getElementById('pw-noname').focus()");
    const r = await act("type", { text: "hunter2" });
    assert.equal(r.code, "secret_field");
  });

  it("чтение getValue маскирует и «показанный пароль» (type=text + current-password)", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await page.callIsolated(fns.pageActInPage, "getValue", { selector: "#pw-shown", prop: "value" });
    assert.equal(r.value, "•••");
  });

  it("service worker: type в секретное поле → ошибка с кодом secret_field первым словом", async () => {
    await page.open(fixtureUrl("form.html"));
    const { env } = swOnPage(page);
    await assert.rejects(env.tabAct("", "type", { selector: "#pw-noname", text: "hunter2" }, 1), (e) => e.code === "secret_field" && /^secret_field:/u.test(e.message));
    assert.equal(await page.eval("document.getElementById('pw-noname').value"), "");
  });
});
