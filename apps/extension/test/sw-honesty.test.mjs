// Честность исхода на уровне service worker (адверс-ревью W1): берст стопится на uncertain/navigated (EXT-6), ввод без
// цели не уходит в чужой фрейм (EXT-8), «вкладки нет» — код tab_gone, а не «элемента нет» (W1-7).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadServiceWorker } from "./cdp-harness.mjs";

const TAB = { id: 1, windowId: 1, active: true, url: "https://x.example/", status: "complete" };

describe("tabBatch: шаг увёл страницу, отправил форму или исход неизвестен — стоп с кодом по исходу", () => {
  const run = (outcomes) => {
    const seen = [];
    const env = loadServiceWorker({
      tabs: { get: async () => TAB, query: async () => [TAB] },
      tabAct: async (_u, intent) => { seen.push(intent); return outcomes[seen.length - 1] ?? { ok: true }; },
    });
    return { env, seen };
  };
  const steps = [{ intent: "click", selector: "#a" }, { intent: "type", selector: "#b", params: { text: "x" } }];

  // Р2 (NEW-2, submit-nav): достоверный переход и отправка формы — СВОИ коды (шаг выполнен), uncertain — только неизвестный исход.
  for (const [name, first] of [
    ["uncertain", { ok: true, navigated: "https://x.example/next", uncertain: true }],
    ["navigated", { ok: true, navigated: "https://x.example/next" }],
    ["submitted", { ok: true, value: "x", submitted: true }],
  ]) {
    it(`${name} на шаге 1 из 2 → ok:false, code ${name}, шаг 2 НЕ исполнен`, async () => {
      const { env, seen } = run([first]);
      const r = await env.tabBatch("", steps, 1);
      assert.deepEqual([r.ok, r.code, r.stoppedAt, r.done, r.total], [false, name, 0, 1, 2], JSON.stringify(r));
      assert.match(r.error, new RegExp(`^${name}:`, "u"));
      assert.deepEqual(seen, ["click"]);
    });
  }

  it("ввод без Enter (submitted:false) и navigated:false — берст идёт дальше", async () => {
    const { env, seen } = run([{ ok: true, value: "x", submitted: false, navigated: false }]);
    const r = await env.tabBatch("", steps, 1);
    assert.deepEqual([r.ok, r.done], [true, 2], JSON.stringify(r));
    assert.deepEqual(seen, ["click", "type"]);
  });

  it("uncertain на ПОСЛЕДНЕМ шаге — берст выполнен, исход шага отдан как есть", async () => {
    const { env } = run([{ ok: true }, { ok: true, uncertain: true, navigated: "https://x.example/n" }]);
    const r = await env.tabBatch("", steps, 1);
    assert.equal(r.ok, true);
    assert.equal(r.results[1].result.uncertain, true);
  });
});

describe("tabAct type без selector: фреймы не щупаем", () => {
  it("не найдено в top → честный not_found, ввода в «любое поле» чужого фрейма нет", async () => {
    const calls = [];
    const env = loadServiceWorker({
      tabs: { get: async () => TAB, query: async () => [TAB] },
      scripting: {
        executeScript: async (inj) => {
          calls.push(inj);
          if (inj.target.allFrames) return [{ frameId: 0, result: { found: false } }, { frameId: 7, result: { found: true, score: 40, url: "https://widget.example/" } }];
          if (inj.target.frameIds) return [{ frameId: 7, result: { ok: true, value: "текст" } }];
          return [{ frameId: 0, result: { ok: false, code: "not_found", error: "поле ввода не найдено" } }];
        },
      },
    });
    for (const params of [{ text: "привет" }, { text: "привет", label: "Комментарий" }]) {
      calls.length = 0;
      await assert.rejects(env.tabAct("", "type", params, 1), (e) => e.code === "not_found");
      assert.equal(calls.length, 1, `щупал фреймы: ${JSON.stringify(params)}`);
    }
  });
});

describe("нет целевой вкладки → tab_gone", () => {
  it("tabAct и tabBatch по хосту без открытой вкладки — ошибка с кодом tab_gone, в страницу не ходим", async () => {
    let injected = 0;
    const env = loadServiceWorker({
      tabs: { get: async () => TAB, query: async () => [TAB] },
      scripting: { executeScript: async () => { injected += 1; return [{ result: { ok: true } }]; } },
    });
    await assert.rejects(env.tabAct("https://nope.example/", "click", { selector: "#a" }), (e) => e.code === "tab_gone" && /^tab_gone:/u.test(e.message));
    await assert.rejects(env.tabBatch("https://nope.example/", [{ intent: "click", selector: "#a" }]), (e) => e.code === "tab_gone");
    assert.equal(injected, 0);
  });
});
