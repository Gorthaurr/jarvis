// W1-D1 (стенд, закон 1): chrome.scripting.executeScript РЕЗОЛВИТСЯ без результата, когда клик увёл страницу (кнопка
// POST-формы «Оплатить»): документ выгрузился посреди функции. Оплата прошла, а tabAct отвечал «executeScript без
// результата» без кода → сервер: «Не вышло» + координатный хатч → повторный клик = двойная оплата. Теперь исход по месту
// и интенту (modules/page-left.js): вкладка ушла → navigated+uncertain; на месте → page_gone; чтение → page_gone.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadServiceWorker } from "./cdp-harness.mjs";

const BEFORE = { id: 1, windowId: 1, active: true, url: "https://online.sberbank.ru/?run=r1", status: "complete" };

/**
 * SW, у которого executeScript заданной page-функции возвращает ровно то, что отдаёт Chrome при выгрузке документа:
 * [{frameId, result: undefined}] (или [] — `empty:"array"`). После пустого ответа вкладка — `after`.
 */
function sw(emptyFn, after, empty = "result") {
  const calls = [];
  let left = false;
  const env = loadServiceWorker({
    tabs: { get: async () => (left ? after : BEFORE), query: async () => [left ? after : BEFORE] },
    scripting: {
      executeScript: async (inj) => {
        calls.push(inj.func.name);
        if (inj.func.name !== emptyFn) return [{ frameId: 0, result: { ok: true, value: "x" } }];
        left = true;
        if (empty === "pagehide") return [{ frameId: 0, result: { ok: true, pageLeft: true, navigated: true, uncertain: true } }];
        if (empty === "slow") return [{ frameId: 0, result: { ok: true, method: "pointer", changed: false } }];
        return empty === "array" ? [] : [{ frameId: 0, result: undefined }];
      },
    },
    findTargetTab: async () => BEFORE,
    waitForTabReady: async () => "complete",
    sleep: async () => {},
  });
  return { env, calls };
}

const LOADING_PAY = { ...BEFORE, url: "https://online.sberbank.ru/pay", status: "loading" };

describe("W1-D1: executeScript без результата у МЕНЯЮЩЕГО действия — честный исход, не «не вышло»", () => {
  for (const [name, params] of [["ref", { ref: "e5_0" }], ["selector", { selector: "#payform > button" }], ["text", { text: "Оплатить" }]]) {
    it(`клик по ${name} увёл страницу (адрес сменился, грузится) → ok + navigated + uncertain`, async () => {
      const { env } = sw("robustClickMain", LOADING_PAY);
      const r = await env.tabAct("", "click", params, 1);
      assert.deepEqual([r.ok, r.navigated, r.uncertain], [true, "https://online.sberbank.ru/pay", true], JSON.stringify(r));
    });
  }

  it("POST-навигация не закоммичена (url прежний, грузится) → navigated = КУДА уходит (pendingUrl)", async () => {
    const { env } = sw("robustClickMain", { ...BEFORE, pendingUrl: "https://online.sberbank.ru/pay", status: "loading" });
    const r = await env.tabAct("", "click", { ref: "e5_0" }, 1);
    assert.deepEqual([r.ok, r.navigated, r.uncertain], [true, "https://online.sberbank.ru/pay", true], JSON.stringify(r));
  });

  it("пустой массив результатов (фрейм выгружен до ответа) — тот же исход", async () => {
    const { env } = sw("robustClickMain", { ...BEFORE, url: "https://online.sberbank.ru/pay" }, "array");
    const r = await env.tabAct("", "click", { ref: "e5_0" }, 1);
    assert.deepEqual([r.ok, r.uncertain], [true, true], JSON.stringify(r));
  });

  it("вкладка на прежнем адресе и догружена → page_gone («исход неизвестен»), а не безкодовое «не вышло»", async () => {
    const { env } = sw("robustClickMain", BEFORE);
    await assert.rejects(env.tabAct("", "click", { ref: "e5_0" }, 1), (e) => e.code === "page_gone" && /могло сработать/u.test(e.message));
  });

  it("type+enter (ввод с отправкой формы) — тоже меняющее: navigated + uncertain", async () => {
    const { env } = sw("elementActIsolated", LOADING_PAY);
    const r = await env.tabAct("", "type", { selector: "#q", text: "100", enter: true }, 1);
    assert.deepEqual([r.ok, r.uncertain], [true, true], JSON.stringify(r));
  });

  it("play по ref увёл страницу — плеер новой страницы не судит клик (исход как есть, без ложного «не заиграло»)", async () => {
    const { env, calls } = sw("robustClickMain", LOADING_PAY);
    const r = await env.tabAct("", "play", { ref: "e5_0" }, 1);
    assert.deepEqual([r.ok, r.uncertain], [true, true], JSON.stringify(r));
    assert.ok(!calls.includes("readMediaStateIsolated"), calls.join(","));
  });
});

describe("W1-D1: пустой результат там, где действия не было или оно ничего не меняет", () => {
  it("штамп ref (подготовка ДО клика) без результата → ref_stale «ничего не выполнял», клика нет", async () => {
    const { env, calls } = sw("stampRefIsolated", LOADING_PAY);
    await assert.rejects(env.tabAct("", "click", { ref: "e5_0" }, 1), (e) => e.code === "ref_stale");
    assert.deepEqual(calls, ["stampRefIsolated"]);
  });

  it("клик во фрейме (ref f7…) без результата → frame_gone (фрейм, не вкладка: переходом не выдаём)", async () => {
    const { env } = sw("robustClickMain", LOADING_PAY);
    await assert.rejects(env.tabAct("", "click", { ref: "f7e5_0" }, 1), (e) => e.code === "frame_gone");
  });

  it("чтение (getValue) без результата → page_gone «перезагрузилась — повтори», не переход", async () => {
    const { env } = sw("pageActInPage", LOADING_PAY);
    await assert.rejects(env.tabAct("", "getValue", { selector: "body" }, 1), (e) => e.code === "page_gone" && /Повтори/u.test(e.message));
  });
});

// 27.09 (bfcache, боевой Moodle «Вход»): замороженный документ результата не отдаёт вовсе — robustClickMain отвечает сам
// по pagehide маркером pageLeft. Маркер — не исход: куда ушла вкладка и чей это уход (вкладки/фрейма), решает SW.
describe("27.09: page-функция ответила pageLeft (pagehide) — исход по месту, как у пустого результата", () => {
  it("top-клик → navigated = КУДА ушла вкладка (адрес, а не true), uncertain", async () => {
    const { env } = sw("robustClickMain", LOADING_PAY, "pagehide");
    const r = await env.tabAct("", "click", { selector: "#go" }, 1);
    assert.deepEqual([r.ok, r.navigated, r.uncertain, r.pageLeft], [true, "https://online.sberbank.ru/pay", true, undefined], JSON.stringify(r));
  });

  it("клик во фрейме (ref f7…) → frame_gone, уходом вкладки не выдаём", async () => {
    const { env } = sw("robustClickMain", LOADING_PAY, "pagehide");
    await assert.rejects(env.tabAct("", "click", { ref: "f7e5_0" }, 1), (e) => e.code === "frame_gone");
  });

  it("вкладка на прежнем адресе и догружена → page_gone («исход неизвестен»), не «перешла»", async () => {
    const { env } = sw("robustClickMain", BEFORE, "pagehide");
    await assert.rejects(env.tabAct("", "click", { selector: "#go" }, 1), (e) => e.code === "page_gone");
  });
});

// Ревью р1 (27.09): медленный POST — ответ сайта дольше ожидания клика: документ на месте, контент не менялся, но вкладка
// УЖЕ грузится. «Не отреагировала» (changed:false) — ложь, модель кликнула бы снова (двойная отправка).
describe("27.09: клик без изменений, но вкладка грузится (медленный POST) — переход вероятен, исход не подтверждён", () => {
  it("top-клик, вкладка loading + pendingUrl → navigated = pendingUrl, uncertain", async () => {
    const { env } = sw("robustClickMain", { ...BEFORE, pendingUrl: "https://online.sberbank.ru/pay", status: "loading" }, "slow");
    const r = await env.tabAct("", "click", { selector: "#go" }, 1);
    assert.deepEqual([r.ok, r.navigated, r.uncertain], [true, "https://online.sberbank.ru/pay", true], JSON.stringify(r));
  });

  it("контроль: вкладка догружена и на месте → прежний честный ответ changed:false (не выдумываем переход)", async () => {
    const { env } = sw("robustClickMain", BEFORE, "slow");
    const r = await env.tabAct("", "click", { ref: "e5_0" }, 1);
    assert.deepEqual([r.ok, r.changed, r.navigated, r.uncertain], [true, false, undefined, undefined], JSON.stringify(r));
  });

  it("наведение (hover) и клик во фрейме не превращаются в «переход»", async () => {
    const loading = { ...BEFORE, pendingUrl: "https://online.sberbank.ru/pay", status: "loading" };
    const hover = await sw("robustClickMain", loading, "slow").env.tabAct("", "hover", { selector: "#go" }, 1);
    assert.equal(hover.navigated, undefined, JSON.stringify(hover));
    const framed = await sw("robustClickMain", loading, "slow").env.tabAct("", "click", { ref: "f7e5_0" }, 1);
    assert.equal(framed.navigated, undefined, JSON.stringify(framed));
  });
});