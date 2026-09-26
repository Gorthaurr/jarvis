// Контракт клавиш (W1-ревью р2) в настоящем Chromium: разбор combo — по общей таблице fixtures/key-combos.json (её же
// читает серверный key-combo-contract.test.ts); клавиши активации (Enter/Space) судятся подписями самой цели; Enter в
// элемент в фокусе без цели — тоже гард. Каждый тест проверен реверт-мутацией (сломан гард/разбор → тест красный).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, serverGuardSource } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["elementActIsolated"]);
const GUARD = serverGuardSource();
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/key-combos.json", import.meta.url), "utf8"));
const canon = (domKey) => (domKey === " " ? "space" : domKey.toLowerCase());

describe("key: общий разбор combo (стык с сервером)", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); await page.open(fixtureUrl("approve.html")); });
  after(async () => { await page?.close(); });

  for (const row of cases) {
    it(`«${row.combo}» → ${row.key === null ? "invalid_combo, ничего не нажато" : row.event}`, async () => {
      await page.eval("window.__k = []");
      const r = await page.callIsolated(fns.elementActIsolated, null, "key", { selector: "#keys", combo: row.combo });
      if (row.key === null) {
        assert.equal(r.code, "invalid_combo", JSON.stringify(r));
        assert.deepEqual(await page.eval("window.__k"), []);
        return;
      }
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(await page.eval("window.__k"), [row.event]);
      // Строка таблицы согласована: event — это ровно key + mods (их проверяет сервер).
      const [k, ...flags] = row.event.split(",");
      assert.equal(canon(k), row.key);
      assert.deepEqual(["ctrl", "shift", "alt", "meta"].filter((_, i) => flags[i] === "true"), [...row.mods].sort((a, b) => ["ctrl", "shift", "alt", "meta"].indexOf(a) - ["ctrl", "shift", "alt", "meta"].indexOf(b)));
    });
  }
});

describe("§14: клавиши активации судятся подписями цели", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const act = (intent, params) => page.callIsolated(fns.elementActIsolated, null, intent, { ...params, guard: GUARD });

  for (const [name, intent, params, counter, label] of [
    ["Space на role=button «Оплатить 50 000 ₽»", "key", { selector: "#pay2", combo: "Space" }, "pay2", "Оплатить 50 000 ₽"],
    ["Enter на role=button «Оплатить 50 000 ₽»", "key", { selector: "#pay2", combo: "Enter" }, "pay2", "Оплатить 50 000 ₽"],
    ["Enter на role=menuitem «Удалить навсегда»", "key", { selector: "#del", combo: "Enter" }, "del", "Удалить навсегда"],
    ["intent enter на menuitem по подписи", "enter", { text: "Удалить навсегда" }, "del", "Удалить навсегда"],
    ["Enter на ссылке «Оплатить заказ»", "key", { selector: "#paylink", combo: "Enter" }, "paylink", "Оплатить заказ"],
  ]) {
    it(`${name} → commit_confirm, обработчик страницы не сработал`, async () => {
      await page.open(fixtureUrl("approve.html"));
      const r = await act(intent, params);
      assert.equal(r.code, "commit_confirm", JSON.stringify(r));
      assert.equal(r.label, label);
      assert.equal(await page.eval(`window.__c.${counter}`), 0);
    });
  }

  it("Space в текстовом поле формы с «Отправить» — не вопрос (Space не отправляет)", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("key", { selector: "#msg", combo: "Space" });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it("P.key — синоним combo: key:'Ctrl+Enter' в поле формы «Отправить» → commit_confirm (ext-tests-7)", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("key", { selector: "#msg", key: "Ctrl+Enter" });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.deepEqual(await page.eval("[window.__c.guarded, window.__c.keys.length]"), [0, 0]);
  });

  for (const [intent, params] of [["key", { combo: "Enter" }], ["key", { combo: "Ctrl+Enter" }], ["enter", {}], ["submit", {}]]) {
    it(`${intent} ${params.combo ?? ""} без цели — в поле в фокусе: гард его формы, форма не ушла (ext-tests-3)`, async () => {
      await page.open(fixtureUrl("form.html"));
      await page.eval("document.getElementById('msg').focus()");
      const r = await act(intent, params);
      assert.equal(r.code, "commit_confirm", JSON.stringify(r));
      assert.deepEqual(await page.eval("[window.__c.guarded, window.__c.keys.length]"), [0, 0]);
    });
  }
});
