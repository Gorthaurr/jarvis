// Честность исхода на уровне service worker (адверс-ревью W1): берст стопится на uncertain/navigated (EXT-6), ввод без
// цели не уходит в чужой фрейм (EXT-8), «вкладки нет» — код tab_gone, а не «элемента нет» (W1-7).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadServiceWorker } from "./cdp-harness.mjs";

const TAB = { id: 1, windowId: 1, active: true, url: "https://x.example/", status: "complete" };

describe("tabBatch: шаг увёл страницу или исход неизвестен — стоп, code uncertain", () => {
  const run = (outcomes) => {
    const seen = [];
    const env = loadServiceWorker({
      tabs: { get: async () => TAB, query: async () => [TAB] },
      tabAct: async (_u, intent) => { seen.push(intent); return outcomes[seen.length - 1] ?? { ok: true }; },
    });
    return { env, seen };
  };
  const steps = [{ intent: "click", selector: "#a" }, { intent: "type", selector: "#b", params: { text: "x" } }];

  for (const [name, first] of [
    ["uncertain", { ok: true, navigated: "https://x.example/next", uncertain: true }],
    ["navigated", { ok: true, navigated: "https://x.example/next" }],
  ]) {
    it(`${name} на шаге 1 из 2 → ok:false, code uncertain, шаг 2 НЕ исполнен`, async () => {
      const { env, seen } = run([first]);
      const r = await env.tabBatch("", steps, 1);
      assert.deepEqual([r.ok, r.code, r.stoppedAt, r.done, r.total], [false, "uncertain", 0, 1, 2], JSON.stringify(r));
      assert.match(r.error, /^uncertain:/u);
      assert.deepEqual(seen, ["click"]);
    });
  }

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
