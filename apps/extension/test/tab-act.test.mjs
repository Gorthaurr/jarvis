// tabAct (уровень service worker): какой page-функцией и с какими аргументами он идёт в страницу. Контроль ревью 26.09:
// type{text:"обновить"} превращался в клик (мимо ввода и §14), approvedLabel терялся на ref-пути.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadServiceWorker } from "./cdp-harness.mjs";

function sw() {
  const calls = [];
  const tab = { id: 1, url: "https://x.example/", status: "complete" };
  const env = loadServiceWorker({
    tabs: { get: async () => tab, query: async () => [tab] },
    scripting: {
      executeScript: async (inj) => {
        calls.push(inj);
        return [{ result: { ok: true } }];
      },
    },
    findTargetTab: async () => tab,
    waitForTabReady: async () => "complete",
    sleep: async () => {},
    hostOf: () => "x.example",
    noTabError: () => new Error("нет вкладки"),
    isPrivateHost: () => false,
    urlPathQuery: () => "/",
  });
  return { env, calls };
}

describe("tabAct — маршрут в страницу", () => {
  it("type с текстом «обновить» — это ВВОД (elementActIsolated), а не клик-встряхивание", async () => {
    const { env, calls } = sw();
    await env.tabAct("https://x.example/", "type", { selector: "#q", text: "обновить данные" }, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].func.name, "elementActIsolated");
    assert.equal(calls[0].args[1], "type");
  });

  it("click «обновить» — встряхивание: robustClickMain с expectChange", async () => {
    const { env, calls } = sw();
    await env.tabAct("https://x.example/", "click", { text: "обновить" }, 1, false);
    assert.equal(calls[0].func.name, "robustClickMain");
    assert.equal(calls[0].args[0].expectChange, true);
  });

  it("ref-клик несёт guard, guardApproved и approvedLabel в robustClickMain", async () => {
    const { env, calls } = sw();
    await env.tabAct("https://x.example/", "click", { ref: "e1_0", guard: "отправ", guardApproved: true, approvedLabel: "Отправить" }, 1, true);
    const click = calls.find((c) => c.func.name === "robustClickMain");
    assert.ok(click, "robustClickMain не вызван");
    assert.equal(click.args[0].guard, "отправ");
    assert.equal(click.args[0].guardApproved, true);
    assert.equal(click.args[0].approvedLabel, "Отправить");
  });

  it("не-ref клик тоже несёт approvedLabel (параметры идут как есть)", async () => {
    const { env, calls } = sw();
    await env.tabAct("https://x.example/", "click", { selector: "#b", guard: "отправ", guardApproved: true, approvedLabel: "Отправить" }, 1, false);
    assert.equal(calls[0].func.name, "robustClickMain");
    assert.equal(calls[0].args[0].approvedLabel, "Отправить");
  });
});
