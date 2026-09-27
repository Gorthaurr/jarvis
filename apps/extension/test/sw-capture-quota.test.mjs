// W1-D5 (стенд): chrome.tabs.captureVisibleTab ограничен квотой Chrome — 2 вызова в секунду на расширение, лишний
// падает ошибкой MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. Модель в одном раунде снимает полный кадр → зум → зум: третий
// снимок приходил capture_failed. Заглушка ниже держит квоту так же, как Chrome (скользящее окно 1 с), и бросает его текст.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadServiceWorker } from "./cdp-harness.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TAB = { id: 1, windowId: 1, active: true, url: "https://shop.example.com/", status: "complete" };
const QUOTA = "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.";

function sw({ extraRefusals = 0 } = {}) {
  const calls = [];
  let refusals = extraRefusals;
  const env = loadServiceWorker({
    tabs: {
      get: async () => TAB,
      query: async () => [TAB],
      captureVisibleTab: async () => {
        const now = Date.now();
        const recent = calls.filter((t) => now - t < 1000).length;
        calls.push(now);
        if (recent >= 2) throw new Error(QUOTA);
        if (refusals > 0) { refusals -= 1; throw new Error(QUOTA); } // джиттер: Chrome отказал и при нашей паузе
        return PNG;
      },
    },
    windows: { get: async () => ({ state: "normal" }) },
    scripting: { executeScript: async () => [{ result: { ok: true, w: 1, h: 1, dpr: 1 } }] },
    renderCapture: async (dataUrl) => dataUrl, // кроп зума рисует OffscreenCanvas (нет в node) — к квоте не относится
    setTimeout,
    clearTimeout,
  });
  return { env, calls };
}

describe("W1-D5: очередь снимков выдерживает квоту Chrome (2 снимка/с)", () => {
  it("три снимка подряд (полный → зум → зум) — все приходят, между вызовами Chrome ≥ 0,5 с", async () => {
    const { env, calls } = sw();
    for (const opts of [{}, { rect: { x: 0, y: 0, w: 1, h: 1 } }, { rect: { x: 0, y: 0, w: 1, h: 1 } }]) {
      const r = await env.tabCapture("", 1, opts, () => {});
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    for (let i = 1; i < calls.length; i += 1) assert.ok(calls[i] - calls[i - 1] >= 500, `вызовы через ${calls[i] - calls[i - 1]} мс`);
  });

  it("три снимка одновременно (две задачи + зум) — все приходят", async () => {
    const { env } = sw();
    const rs = await Promise.all([0, 1, 2].map(() => env.tabCapture("", 1, {}, () => {})));
    assert.deepEqual(rs.map((r) => r.ok), [true, true, true], JSON.stringify(rs.map((r) => r.error)));
  });

  it("Chrome всё же отказал по квоте — повтор после паузы, снимок приходит", async () => {
    const { env, calls } = sw({ extraRefusals: 1 });
    const r = await env.tabCapture("", 1, {}, () => {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.length, 2);
  });

  it("не квота (окно недоступно) — честный capture_failed сразу, без повторов", async () => {
    let n = 0;
    const env = loadServiceWorker({
      tabs: { get: async () => TAB, query: async () => [TAB], captureVisibleTab: async () => { n += 1; throw new Error("Cannot access contents of the page"); } },
      windows: { get: async () => ({ state: "normal" }) },
      scripting: { executeScript: async () => [{ result: { ok: true, w: 1, h: 1, dpr: 1 } }] },
      setTimeout,
      clearTimeout,
    });
    const r = await env.tabCapture("", 1, {}, () => {});
    assert.deepEqual([r.ok, r.code, n], [false, "capture_failed", 1]);
  });
});
