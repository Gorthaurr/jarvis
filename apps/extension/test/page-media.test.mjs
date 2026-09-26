// back/forward = история вкладки (B-6), next/prev по целому слову (B-13) — service worker поверх настоящей страницы.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, swOnPage } from "./cdp-harness.mjs";

describe("B-6: назад/вперёд на странице с плеером — история, а не перемотка", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });

  const ready = async () => {
    await page.open(fixtureUrl("media.html"));
    for (let i = 0; i < 100 && !(await page.eval("document.getElementById('player').duration > 0")); i++) await new Promise((r) => setTimeout(r, 50));
    await page.eval("document.getElementById('player').currentTime = 1.5; location.hash = 'second'");
  };

  it("back уходит по истории, плеер не трогает; forward возвращает", async () => {
    await ready();
    const { env, calls } = swOnPage(page);
    const r = await env.tabAct("", "back", {}, 1);
    assert.equal(r.navigated, true, JSON.stringify(r));
    assert.doesNotMatch(r.url, /#second$/u);
    assert.equal(await page.eval("location.hash"), "");
    assert.equal(await page.eval("document.getElementById('player').currentTime"), 1.5);
    assert.equal(calls.length, 0, "в страницу за «назад» ходить не нужно");
    const f = await env.tabAct("", "forward", {}, 1);
    assert.equal(f.navigated, true);
    assert.match(f.url, /#second$/u);
  });

  it("шаг истории без смены адреса (pushState на тот же URL) — navigated:false, а не «перешёл»", async () => {
    await page.open(fixtureUrl("media.html"));
    await page.eval("history.pushState({ step: 1 }, '', location.href)");
    const { env } = swOnPage(page);
    const r = await env.historyNav(1, "back", 600);
    assert.equal(r.navigated, false);
  });

  it("вперёд некуда → no_history, а не «ok»", async () => {
    await page.open(fixtureUrl("plain.html")); // новый адрес — «вперёд» в истории нет
    const { env } = swOnPage(page);
    await assert.rejects(env.tabAct("", "forward", {}, 1), (e) => e.code === "no_history");
  });
});
