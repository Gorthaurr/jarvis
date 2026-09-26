// Клик расширения (robustClickMain) в настоящем Chromium. Запуск: node --test apps/extension/test/
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["robustClickMain"]);
const click = (page, params) => page.call(fns.robustClickMain, params);

describe("robustClickMain — обычный сайт без React (H19)", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });

  it("кнопка по тексту нажимается ровно один раз, а не «Enter в пустоту»", async () => {
    await page.open(fixtureUrl("plain.html"));
    const r = await click(page, { text: "Сохранить черновик" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("window.__c.save"), 1);
  });

  it("галочка по селектору включается (не переключается туда-обратно двойным кликом)", async () => {
    await page.open(fixtureUrl("plain.html"));
    await click(page, { selector: "#agree" });
    assert.equal(await page.eval("document.getElementById('agree').checked"), true);
  });

  it("ссылка по тексту переходит", async () => {
    await page.open(fixtureUrl("plain.html"));
    await click(page, { text: "Подробнее" });
    assert.equal(await page.eval("location.hash"), "#details");
  });

  it("кнопка-input (type=submit) находится по подписи из value и отправляет форму один раз", async () => {
    await page.open(fixtureUrl("plain.html"));
    const r = await click(page, { text: "Найти" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("window.__c.search"), 1);
  });

  it("плитка без роли с обработчиком клика срабатывает один раз", async () => {
    await page.open(fixtureUrl("plain.html"));
    await click(page, { selector: "#tile" });
    assert.equal(await page.eval("window.__c.tile"), 1);
  });

  it("галочка внутри карточки с tabindex: жмётся САМА галочка, а не карточка-контейнер", async () => {
    await page.open(fixtureUrl("plain.html"));
    await click(page, { text: "Опция в карточке" });
    assert.equal(await page.eval("document.getElementById('opt').checked"), true);
  });

  it("встряхивание (expectChange) по-прежнему доходит до Enter, когда клик глушит свайпер", async () => {
    await page.open(fixtureUrl("plain.html"));
    const r = await click(page, { text: "Встряхнуть", expectChange: true });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.equal(await page.eval("window.__c.shake"), 1);
  });
});

describe("robustClickMain — тест Moodle", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });

  it("вариант ответа выбирается по его тексту (подпись через aria-labelledby)", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const r = await click(page, { text: "Париж" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("document.getElementById('q145678:1_answer2').checked"), true);
    assert.equal(await page.eval("document.getElementById('q145678:1_answer0').checked"), false);
  });

  it("«Следующая страница» (input type=submit) отправляет форму попытки с выбранными ответами", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    await click(page, { text: "Марсель" });
    await click(page, { text: "Следующая страница" });
    const subs = await page.eval("window.__submits");
    assert.equal(subs.length, 1);
    assert.equal(subs[0]["q145678:1_answer"], "1");
    assert.equal(subs[0].next, "Следующая страница");
  });

  it("при открытом модальном окне одноимённая кнопка жмётся В ОКНЕ, а не под затемнением", async () => {
    await page.open(fixtureUrl("moodle-summary.html"));
    await click(page, { text: "Отправить всё и завершить тест" });
    assert.equal(await page.eval("window.__opened"), 1);
    await click(page, { text: "Отправить всё и завершить тест" });
    assert.equal(await page.eval("window.__finished"), 1);
    assert.equal(await page.eval("window.__opened"), 1);
  });

  it("гард коммита: по селектору подпись «Отправить…» → не жмём, отдаём commit_confirm с подписью", async () => {
    await page.open(fixtureUrl("moodle-summary.html"));
    const r = await click(page, { selector: "#single_button_fin", guard: "отправ|submit" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "commit_confirm");
    assert.match(r.label, /Отправить всё и завершить тест/u);
    assert.equal(await page.eval("window.__opened"), 0);
  });

  it("гард коммита: после одобрения (guardApproved) клик проходит", async () => {
    await page.open(fixtureUrl("moodle-summary.html"));
    const r = await click(page, { selector: "#single_button_fin", guard: "отправ|submit", guardApproved: true });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("window.__opened"), 1);
  });

  it("гард не мешает обычным кликам (вариант ответа)", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const r = await click(page, { text: "Лион", guard: "отправ|submit" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("document.getElementById('q145678:1_answer0').checked"), true);
  });
});
