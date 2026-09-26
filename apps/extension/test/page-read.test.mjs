// Чтение вкладки (B-8) в настоящем Chromium: лента целиком, открытое окно — первым.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["readPageInPage"]);

describe("B-8: browser_read видит всю ленту и открытые окна", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); await page.open(fixtureUrl("feed.html")); });
  after(async () => { await page?.close(); });

  it("лента из двух article без main читается целиком, а не первым постом", async () => {
    const r = await page.callIsolated(fns.readPageInPage, "");
    assert.match(r.text, /первого поста/u);
    assert.match(r.text, /второго поста/u);
  });

  it("модалка-портал в конце длинной страницы — в начале текста, не срезана капом", async () => {
    const r = await page.callIsolated(fns.readPageInPage, "");
    assert.match(r.text.slice(0, 300), /Подтвердите возраст/u);
  });

  it("при main — читается main, окно вне main всё равно видно", async () => {
    await page.open(fixtureUrl("plain.html"));
    await page.eval("const d = document.createElement('dialog'); d.textContent = 'Сессия истекает через минуту'; document.body.appendChild(d); d.showModal()");
    const r = await page.callIsolated(fns.readPageInPage, "");
    assert.match(r.text, /Настройки/u);
    assert.match(r.text.slice(0, 200), /Сессия истекает/u);
  });
});
