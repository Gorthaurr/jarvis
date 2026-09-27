// Сценарий: веб-мессенджер (web.max.ru — messenger §14). type по ref с enter:true — один вопрос, сообщение ушло РОВНО
// один раз и с тем текстом. Режим ?mode=ctrl (Enter — перевод строки, Ctrl+Enter — отправка): type без enter ничего
// не отправляет и не спрашивает; key Ctrl+Enter — вопрос; «нет» → ничего, «да» → одно сообщение. Кнопка «Отправить».
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { begin, newRun, open, sleep, tool, waitFacts } from "../lib.mjs";
import { waitsFix } from "./defects.mjs";

let release;
before(async () => {
  release = await begin();
});
after(() => release?.());

async function exactlyOne(run, text) {
  const got = await waitFacts(run, "message_sent", 1);
  assert.equal(got.length, 1, "сообщение не ушло");
  await sleep(1_000);
  const all = await waitFacts(run, "message_sent", 2, 300);
  assert.equal(all.length, 1, `отправок: ${all.length}`);
  assert.equal(got[0].data.text, text);
  return got[0];
}

async function chat(mode = "") {
  const run = newRun("msg");
  await open(`https://web.max.ru/?${mode ? `mode=${mode}&` : ""}run=${run}`);
  await tool("browser_inspect", { url: "web.max.ru" });
  return run;
}

test("type по ref + enter:true + «да» → один вопрос, сообщение ушло ровно один раз", waitsFix("ENTER_APPROVAL"), async () => {
  const run = await chat();
  const text = `Привет, Катя! ${run}`;
  const r = await tool("browser_act", { intent: "type", ref: "$ref:Сообщение", text, enter: true }, { confirm: "yes" });
  assert.equal((await exactlyOne(run, text)).data.via, "enter"); // сначала факт: ушло ли вообще
  assert.equal(r.result.isError, false, r.result.text);
  assert.equal(r.questions.length, 1, r.questions.map((q) => q.summary).join(" | "));
});

test("type по ref + enter:true + «нет» → вопрос есть, сообщения нет", { timeout: 120_000 }, async () => {
  const run = await chat();
  const r = await tool("browser_act", { intent: "type", ref: "$ref:Сообщение", text: "не отправлять", enter: true }, { confirm: "no" });
  assert.equal(r.questions.length, 1, JSON.stringify(r.questions));
  assert.match(r.questions[0].summary, /мессенджер/);
  assert.notEqual(r.result.flags.sent, true);
  assert.equal((await waitFacts(run, "message_sent", 1, 1_500)).length, 0);
});

test("mode=ctrl: type без enter — 0 вопросов, 0 отправок; Ctrl+Enter + «нет» → один вопрос, 0 отправок", { timeout: 120_000 }, async () => {
  const run = await chat("ctrl");
  const typed = await tool("browser_act", { intent: "type", ref: "$ref:Сообщение", text: `Черновик ${run}` });
  assert.equal(typed.result.isError, false, typed.result.text);
  assert.equal(typed.questions.length, 0, "набор без отправки — без вопроса");
  assert.equal((await waitFacts(run, "message_sent", 1, 1_500)).length, 0, "набор ничего не отправил");
  const no = await tool("browser_act", { intent: "key", ref: "$ref:Сообщение", combo: "Ctrl+Enter" }, { confirm: "no" });
  assert.equal(no.questions.length, 1, `Ctrl+Enter в мессенджере — вопрос: ${JSON.stringify(no.questions)}`);
  assert.equal((await waitFacts(run, "message_sent", 1, 1_500)).length, 0, "«нет» → не ушло");
});

test("mode=ctrl: Ctrl+Enter + «да» → один вопрос, ровно одно сообщение", waitsFix("ENTER_APPROVAL"), async () => {
  const run = await chat("ctrl");
  const text = `Многострочное ${run}`;
  await tool("browser_act", { intent: "type", ref: "$ref:Сообщение", text });
  const yes = await tool("browser_act", { intent: "key", ref: "$ref:Сообщение", combo: "Ctrl+Enter" }, { confirm: "yes" });
  assert.equal((await exactlyOne(run, text)).data.via, "ctrl_enter");
  assert.equal(yes.questions.length, 1, yes.questions.map((q) => q.summary).join(" | "));
});

test("набор + клик «Отправить» по ref + «да» → сообщение ушло ровно один раз", { timeout: 120_000 }, async () => {
  const run = await chat();
  const text = `Кнопкой ${run}`;
  const typed = await tool("browser_act", { intent: "type", ref: "$ref:Сообщение", text });
  assert.equal(typed.questions.length, 0);
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Отправить" }, { confirm: "yes" });
  assert.equal(r.result.isError, false, r.result.text);
  assert.ok(r.questions.length >= 1, "отправка в мессенджере — только с вопросом (ровно один — см. W1-D2 в bank.test)");
  assert.equal((await exactlyOne(run, text)).data.via, "button");
});
