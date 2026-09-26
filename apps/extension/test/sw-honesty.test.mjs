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

// Р2 srv-regress-4: смерть контекста ДО действия (инъекция во фрейм, которого нет; штамп ref) — «не выполнял», а не
// «исход неизвестен». Ошибки — ровно те строки, что бросает chrome.scripting.executeScript.
describe("смерть контекста: до действия — frame_missing/ref_stale, посреди — frame_gone", () => {
  const TOPNAV = { ...TAB, url: "https://x.example/next", status: "loading" };
  const run = (fail) => {
    const calls = [];
    let n = 0;
    const env = loadServiceWorker({
      tabs: { get: async () => (n > 0 ? TOPNAV : TAB), query: async () => [TAB] },
      scripting: {
        executeScript: async (inj) => {
          calls.push(inj.func.name);
          const msg = fail(inj.func.name);
          if (msg) { n += 1; throw new Error(msg); }
          return [{ result: { ok: true } }];
        },
      },
      sleep: async () => {},
    });
    return { env, calls };
  };

  it("ref во фрейме, которого уже нет («No frame with id») — frame_missing, клика не было", async () => {
    const { env, calls } = run((fn) => (fn === "stampRefIsolated" ? "No frame with id 7 in tab 1." : ""));
    await assert.rejects(env.tabAct("", "click", { ref: "f7e1_2" }, 1), (e) => e.code === "frame_missing");
    assert.deepEqual(calls, ["stampRefIsolated"]);
  });

  it("фрейм удалён во время штампа (до действия) — frame_missing", async () => {
    const { env } = run((fn) => (fn === "stampRefIsolated" ? "Frame with ID 7 was removed." : ""));
    await assert.rejects(env.tabAct("", "click", { ref: "f7e1_2" }, 1), (e) => e.code === "frame_missing");
  });

  it("фрейм удалён посреди клика — frame_gone (исход неизвестен)", async () => {
    const { env } = run((fn) => (fn === "robustClickMain" ? "Frame with ID 7 was removed." : ""));
    await assert.rejects(env.tabAct("", "click", { ref: "f7e1_2" }, 1), (e) => e.code === "frame_gone");
  });

  it("ввод во фрейм, которого нет (селектор + frameId) — frame_missing", async () => {
    const { env } = run((fn) => (fn === "elementActIsolated" ? "No frame with id 9 in tab 1." : ""));
    await assert.rejects(env.tabAct("", "type", { selector: "#q", text: "x", frameId: 9 }, 1), (e) => e.code === "frame_missing");
  });

  it("top-страница ушла во время штампа ref — ref_stale, а не «клик увёл страницу» и не клик по новой", async () => {
    const { env, calls } = run((fn) => (fn === "stampRefIsolated" ? "Frame with ID 0 was removed." : ""));
    await assert.rejects(env.tabAct("", "click", { ref: "e1_2" }, 1), (e) => e.code === "ref_stale");
    assert.deepEqual(calls, ["stampRefIsolated"]);
  });
});

// B-16 (контракт с сервером): вкладка не догрузилась за ожидание — ответы read/inspect/act несут loading:true (сервер
// ставит пометку «ещё грузилась» и не засчитывает readback сверкой).
describe("вкладка не догрузилась — loading:true в ответах read / inspect / act", () => {
  it("tabRead, tabInspect и tabAct", async () => {
    const SLOW = { ...TAB, status: "loading" };
    const page = { readPageInPage: { title: "t", url: TAB.url, text: "x", headings: [] }, inspectPageInPage: { url: TAB.url, title: "t", elements: [] } };
    const env = loadServiceWorker({
      tabs: { get: async () => SLOW, query: async () => [SLOW] },
      scripting: { executeScript: async (inj) => [{ frameId: 0, result: page[inj.func.name] ?? { ok: true, value: "x" } }] },
      waitForTabReady: async () => "loading",
    });
    assert.equal((await env.tabRead("", 1, "")).loading, true);
    assert.equal((await env.tabInspect("", "", 80, 1)).loading, true);
    assert.equal((await env.tabAct("", "type", { selector: "#q", text: "x" }, 1)).loading, true);
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
