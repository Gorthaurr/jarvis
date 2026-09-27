// Закон 2: в движке расширения нет хардкода сайтов — знание о сайте несёт серверный рецепт, а не код клика.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { findChrome, launchPage, pageFunctionSources } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["robustClickMain"]);

describe("закон 2: Яндекс «вруби волну» больше не зашит в клик", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  let server;
  before(async () => {
    page = await launchPage();
    // Хост с «yandex» в имени: *.localhost Chrome резолвит в loopback сам (сеть наружу у стенда закрыта).
    server = createServer((_q, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><meta charset="utf-8"><title>Музыка</title><button id="w" onclick="window.__w=(window.__w||0)+1">Моя волна</button>');
    });
    await new Promise((r) => server.listen(0, r));
  });
  after(async () => { await page?.close(); server?.close(); });

  it("клик «Моя волна» на music.yandex.* жмёт кнопку страницы, а не уводит вкладку на music.yandex.ru", async () => {
    await page.open(`http://music.yandex.localhost:${server.address().port}/`);
    const r = await page.call(fns.robustClickMain, { text: "Моя волна" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("window.__w"), 1);
    assert.match(await page.eval("location.host"), /yandex\.localhost/u);
  });
});
