// tab.capture (W1 A9): снимок/зум вкладки через service worker поверх настоящего Chromium (captureVisibleTab = CDP-снимок
// вьюпорта), отрисовка кропа — та же функция renderCapture, исполненная в странице.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, swOnPage } from "./cdp-harness.mjs";
import { renderCapture } from "../modules/capture-render.js";
import { replyFor } from "../modules/reply.js";

const PIXEL = `async (d, x, y) => {
  const bm = await createImageBitmap(await (await fetch(d)).blob());
  const c = new OffscreenCanvas(bm.width, bm.height);
  const g = c.getContext("2d");
  g.drawImage(bm, 0, 0);
  return { w: bm.width, h: bm.height, px: [...g.getImageData(x, y, 1, 1).data].slice(0, 3) };
}`;

describe("tab.capture — снимок и зум вкладки", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const sw = (extra = {}) => swOnPage(page, { renderCapture: (d, p) => page.call(renderCapture.toString(), d, p), ...extra });
  const shot = (env, opts) => env.tabCapture("", 1, opts, env.captureTargetIsolated);
  const pixel = (d, x, y) => page.call(PIXEL, d, x, y);

  it("зум rect: кроп красного блока ×2, в центре — красный", async () => {
    await page.open(fixtureUrl("capture.html"));
    const { env } = sw();
    const r = await shot(env, { rect: { x: 40, y: 30, w: 100, h: 50 } });
    assert.equal(r.ok, true, JSON.stringify({ ...r, dataUrl: undefined }));
    assert.deepEqual([r.width, r.height, r.dpr], [200, 100, 1]);
    assert.deepEqual({ ...r.cssRect }, { x: 40, y: 30, w: 100, h: 50 });
    const p = await pixel(r.dataUrl, 100, 50);
    assert.deepEqual([p.w, p.h, p.px], [200, 100, [255, 0, 0]]);
  });

  it("без rect — весь вьюпорт в пределах потолка", async () => {
    await page.open(fixtureUrl("capture.html"));
    const { env } = sw();
    const r = await shot(env, {});
    assert.equal(r.ok, true);
    assert.ok(Math.max(r.width, r.height) <= 1568 && r.width * r.height <= 1_150_000);
    assert.match(r.dataUrl, /^data:image\/png;base64,/u);
  });

  it("зум по ref элемента ниже сгиба: прокручивает к нему, в кадре — сам элемент", async () => {
    await page.open(fixtureUrl("capture.html"));
    const { env } = sw();
    const ref = (await env.tabInspect("", "", 80, 1)).elements.find((e) => e.selector === "#far").ref;
    const r = await shot(env, { ref });
    assert.equal(r.ok, true, JSON.stringify({ ...r, dataUrl: undefined }));
    const p = await pixel(r.dataUrl, Math.floor(r.width / 2), Math.floor(r.height / 2));
    assert.deepEqual(p.px, [0, 255, 0]);
  });

  it("dpr 2: кроп в ФИЗИЧЕСКИХ пикселях", async () => {
    await page.open(fixtureUrl("capture.html"));
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
    try {
      const { env } = sw();
      const r = await shot(env, { rect: { x: 40, y: 30, w: 100, h: 50 } });
      assert.equal(r.dpr, 2);
      assert.deepEqual([r.width, r.height], [400, 200]);
      assert.deepEqual((await pixel(r.dataUrl, 200, 100)).px, [255, 0, 0]);
    } finally {
      await page.cdp("Emulation.clearDeviceMetricsOverride", {});
    }
  });

  it("вкладка не на переднем плане → tab_not_visible, снимок не делается", async () => {
    await page.open(fixtureUrl("capture.html"));
    let shots = 0;
    const { env } = sw({ tabs: { get: async () => ({ id: 1, windowId: 1, active: false, status: "complete", url: "file:///x" }), captureVisibleTab: async () => { shots += 1; return ""; } } });
    const r = await shot(env, {});
    assert.deepEqual([r.ok, r.code, shots], [false, "tab_not_visible", 0]);
  });

  it("владелец переключил вкладку во время снимка → tab_not_visible, чужой кадр не отдаём", async () => {
    await page.open(fixtureUrl("capture.html"));
    let switched = false;
    const tab = () => ({ id: 1, windowId: 1, active: !switched, status: "complete", url: "file:///x" });
    const { env } = sw({ tabs: { get: async () => tab(), query: async () => [tab()], captureVisibleTab: async () => { switched = true; return page.screenshot(); } } });
    const r = await shot(env, {});
    assert.deepEqual([r.ok, r.code], [false, "tab_not_visible"]);
  });

  it("ref во встроенном фрейме → capture_failed без инжекции; провал — данными, не исключением", async () => {
    await page.open(fixtureUrl("capture.html"));
    const { env, calls } = sw();
    const r = await shot(env, { ref: "f3e12345_1" });
    assert.deepEqual([r.ok, r.code, calls.length], [false, "capture_failed", 0]);
    const reply = await replyFor({ id: "c1", type: "tab.capture", url: "", tabId: 1, ref: "f3e12345_1" }, env.handle);
    assert.equal(reply.ok, true);
    assert.equal(reply.data.code, "capture_failed");
  });
});
