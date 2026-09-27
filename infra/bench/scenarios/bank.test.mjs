// Сценарий: банк (online.sberbank.ru — опасный хост §14). «Оплатить» по ref: «нет» → ровно один вопрос, declined,
// денег не списано; «да» → оплата РОВНО одна. Плюс честность исхода: клик, уведший страницу (POST-форма), не должен
// рапортоваться «не вышло», и на один клик — один вопрос (оба пока ждут фикса W1, см. defects.mjs).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { begin, newRun, open, sleep, tool, waitFacts } from "../lib.mjs";
import { waitsFix } from "./defects.mjs";

let release;
before(async () => {
  release = await begin();
});
after(() => release?.());

async function payOnce(confirm) {
  const run = newRun("bank");
  await open(`https://online.sberbank.ru/?run=${run}`);
  const insp = await tool("browser_inspect", { url: "online.sberbank.ru", query: "оплатить" });
  assert.equal(insp.result.isError, false, insp.result.text);
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Оплатить" }, { confirm });
  return { run, r };
}

test("«Оплатить» + «нет» → ровно один вопрос, declined, списаний нет", { timeout: 120_000 }, async () => {
  const { run, r } = await payOnce("no");
  assert.equal(r.questions.length, 1, JSON.stringify(r.questions));
  assert.equal(r.questions[0].kind, "irreversible");
  assert.match(r.questions[0].summary, /банк/);
  assert.equal(r.result.flags.declined, true, r.result.text);
  assert.notEqual(r.result.flags.sent, true);
  assert.equal((await waitFacts(run, "payment", 1, 1_500)).length, 0, "после «нет» денег не списано");
});

test("«Оплатить» + «да» → оплата ровно одна", { timeout: 120_000 }, async () => {
  const { run } = await payOnce("yes");
  assert.equal((await waitFacts(run, "payment", 1)).length, 1);
  await sleep(1_000);
  assert.equal((await waitFacts(run, "payment", 2, 300)).length, 1, "ровно одна оплата");
});

test("«Оплатить» + «да» → на один клик ровно ОДИН вопрос владельцу", waitsFix("DOUBLE_CONFIRM"), async () => {
  const { r } = await payOnce("yes");
  assert.equal(r.questions.length, 1, `вопросов ${r.questions.length}: ${r.questions.map((q) => q.summary).join(" | ")}`);
});

test("«Оплатить» + «да» → исход честный: оплата прошла — инструмент не говорит «не вышло»", waitsFix("NAV_NO_RESULT"), async () => {
  const { run, r } = await payOnce("yes");
  assert.equal((await waitFacts(run, "payment", 1)).length, 1, "оплата реально прошла");
  const honest = r.result.isError === false || r.result.flags.uncertain === true;
  assert.ok(honest, `инструмент: isError=${r.result.isError} flags=${JSON.stringify(r.result.flags)} — ${r.result.text.slice(0, 160)}`);
});

test("«Перевести» (fetch, без ухода со страницы) + «да» → один вопрос, перевод ровно один", { timeout: 120_000 }, async () => {
  const run = newRun("bank-tr");
  await open(`https://online.sberbank.ru/?run=${run}`);
  await tool("browser_inspect", { url: "online.sberbank.ru" });
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Перевести" }, { confirm: "yes" });
  assert.equal(r.result.isError, false, r.result.text);
  assert.ok(r.questions.length >= 1, "перевод на банке — только с вопросом владельцу");
  assert.equal((await waitFacts(run, "transfer", 1)).length, 1);
  await sleep(1_000);
  assert.equal((await waitFacts(run, "transfer", 2, 300)).length, 1, "ровно один перевод");
});
