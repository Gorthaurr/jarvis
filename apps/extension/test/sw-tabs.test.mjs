// Service worker: выбор вкладки (B-9), конверт ответа с кодом (контракт W1 §7). Модули SW — настоящие (vm).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadServiceWorker } from "./cdp-harness.mjs";
import { replyFor } from "../modules/reply.js";
import { codedError, pageFailure } from "../modules/utils.js";

/** SW с вкладками-заглушками: живые — из `tabs`, остальные id — «No tab with id» (как chrome.tabs.get у закрытой). */
function swWith(tabs, extra = {}) {
  const calls = [];
  const created = [];
  const byId = (id) => tabs.find((t) => t.id === id);
  const env = loadServiceWorker({
    tabs: {
      // chrome.tabs.get бывает и с колбэком (waitTabComplete) — поддерживаем оба вида.
      get: (id, cb) => {
        const p = (async () => { const t = byId(id); if (!t) throw new Error("No tab with id: " + id); return typeof t.get === "function" ? t.get() : t; })();
        if (cb) p.then(cb, () => cb(undefined));
        return p;
      },
      query: async (q) => (q && q.active ? tabs.filter((t) => t.active) : q && q.url ? [] : tabs),
      create: async (o) => { const t = { id: 99, url: o.url, status: "complete", active: false }; created.push(o); tabs.push(t); return t; },
      reload: async () => {},
      ...extra.tabs,
    },
    scripting: { executeScript: async (inj) => { calls.push(inj); return [{ frameId: 0, result: { ok: true, value: "текст", len: 5, blank: false, elements: [], text: "" } }]; } },
    runtime: { lastError: undefined },
    setTimeout,
    clearTimeout,
  });
  return { env, calls, created };
}

const OWNER_TAB = { id: 1, url: "https://mail.example/inbox", status: "complete", active: true };

describe("B-9: закрытая явная вкладка → tab_closed, а не активная вкладка владельца", () => {
  for (const [name, run] of [
    ["tab.read", (env) => env.tabRead("", 7, "")],
    ["tab.inspect", (env) => env.tabInspect("", "", 80, 7)],
    ["tab.act type", (env) => env.tabAct("", "type", { selector: "#q", text: "привет" }, 7)],
    ["tab.batch", (env) => env.tabBatch("", [{ intent: "click", ref: "e1_0" }], 7)],
  ]) {
    it(`${name}: код tab_closed, в страницу ничего не ушло`, async () => {
      const { env, calls } = swWith([{ ...OWNER_TAB }]);
      await assert.rejects(run(env), (e) => e.code === "tab_closed" && /^tab_closed:/u.test(e.message));
      assert.equal(calls.length, 0, "скрипт ушёл в чужую вкладку");
    });
  }

  it("наблюдение (recover) за закрытой вкладкой чинит её — переоткрывает по url, а не падает", async () => {
    const { env, created } = swWith([{ ...OWNER_TAB }]);
    const r = await env.tabAct("https://shop.example/order/1", "getValue", { selector: "body", recover: true }, 7);
    assert.equal(created.length, 1);
    assert.equal(created[0].active, false);
    assert.equal(r.recovered, "reopened");
    assert.equal(r.tabId, 99);
  });

  it("вкладку закрыли, пока она грузилась, → tab_closed (раньше «готово» по таймауту)", async () => {
    let n = 0;
    const loadingThenGone = { id: 5, url: "https://x.example/", status: "loading", get() { n += 1; if (n > 1) throw new Error("No tab with id: 5"); return { ...this, get: undefined }; } };
    const { env } = swWith([loadingThenGone]);
    await assert.rejects(env.tabRead("", 5, ""), (e) => e.code === "tab_closed");
  });

  it("ожидание загрузки честно говорит «ещё грузится», а не true", async () => {
    const { env } = swWith([{ id: 3, url: "https://x.example/", status: "loading" }]);
    assert.equal(await env.waitForTabReady(3, 200), "loading");
    assert.equal(await env.waitForTabReady(4, 200), "gone");
  });
});

describe("конверт ответа: code и label отдельными полями (контракт W1 §7)", () => {
  it("код отказа — первым словом текста и полем code", async () => {
    const r = await replyFor({ id: "m1" }, async () => { throw codedError("secret_field", "поле пароля — вводит владелец"); });
    assert.deepEqual(r, { id: "m1", ok: false, error: "secret_field: поле пароля — вводит владелец", code: "secret_field" });
  });

  it("commit_confirm: после двоеточия — ТОЛЬКО подпись (сервер берёт её до конца строки), label — полем", async () => {
    const r = await replyFor({ id: "m2" }, async () => { throw pageFailure("click", { ok: false, code: "commit_confirm", label: "Оплатить", error: "commit_confirm: Оплатить" }); });
    assert.equal(r.error, "commit_confirm: Оплатить");
    assert.equal(r.code, "commit_confirm");
    assert.equal(r.label, "Оплатить");
  });

  it("успех — {id, ok:true, data}; провал без кода — без поля code", async () => {
    assert.deepEqual(await replyFor({ id: "a" }, async () => 42), { id: "a", ok: true, data: 42 });
    assert.deepEqual(await replyFor({ id: "b" }, async () => { throw new Error("сломалось"); }), { id: "b", ok: false, error: "сломалось" });
  });
});
