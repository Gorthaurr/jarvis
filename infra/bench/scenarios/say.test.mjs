// Сценарий: реплика через НАСТОЯЩУЮ петлю (onDevText → handleUserText → фоновая задача) со сценарным мозгом.
// Проверяем: финал — ровно текст сценария, модель спрошена ровно по сценарию, петля показала модели настоящий
// результат инструмента (заголовок товара со страницы), задача dev завершена; на банке «нет» — ни одной оплаты.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resetTabs } from "../chrome.mjs";
import { begin, newRun, say, waitFacts } from "../lib.mjs";

let release;
before(async () => {
  release = await begin();
});
after(() => release?.());

const FINAL = "В лавке продаётся «Мастер и Маргарита», сэр.";

test("3 хода [browser_open, browser_read, финал] → финал из сценария, задача done, модель видела страницу", { timeout: 180_000 }, async () => {
  await resetTabs();
  const run = newRun("say");
  const r = await say(
    "Зайди в книжную лавку shop.example.com и скажи, какая книга там продаётся",
    {
      turns: [
        { text: "Открываю лавку.", tool_uses: [{ name: "browser_open", input: { url: "https://shop.example.com/?run={{run}}" } }] },
        { tool_uses: [{ name: "browser_read", input: { selectorIntent: "книга" } }] },
        { text: FINAL },
      ],
    },
    { vars: { run } },
  );
  assert.equal(r.timedOut, false);
  assert.ok(r.llm.loopCalls > 0, "реплику закрыл tier0/кэш без модели — сценарий не исполнялся");
  assert.equal(r.final, FINAL, JSON.stringify(r.rounds.map((x) => x.userText)));
  assert.equal(r.llm.loopCalls, 3);
  assert.equal(r.llm.exhausted, false);
  assert.match(r.rounds[2].toolResults[0].text, /Мастер и Маргарита/, "петля отдала модели настоящий текст страницы");
  assert.equal(r.task?.state, "done", JSON.stringify(r.task));
  assert.equal(r.task?.dev, true);
  assert.equal(r.questions.length, 0);
});

test("банк: [open, inspect, click $ref:Оплатить, финал] + «нет» → один вопрос, оплат нет, финал из сценария", { timeout: 180_000 }, async () => {
  await resetTabs();
  const run = newRun("say-bank");
  const final = "Оплату не провёл: вы не подтвердили, сэр.";
  const r = await say(
    "Оплати счёт за ЖКХ в Сбербанке онлайн",
    {
      turns: [
        { tool_uses: [{ name: "browser_open", input: { url: "https://online.sberbank.ru/?run={{run}}" } }] },
        { tool_uses: [{ name: "browser_inspect", input: { query: "оплатить" } }] },
        { tool_uses: [{ name: "browser_act", input: { intent: "click", ref: "$ref:Оплатить" } }] },
        { text: final },
        { text: final }, // goal-check петли может переспросить модель после «Открыл…» — ответ тот же
      ],
    },
    { vars: { run }, confirm: "no" },
  );
  assert.ok(r.llm.loopCalls >= 4, JSON.stringify(r.llm));
  assert.deepEqual(r.rounds[3].unresolved, [], "$ref:Оплатить разрешился из снимка");
  assert.match(r.rounds[3].toolResults[0].text, /Отменено/, "модель увидела честный отказ");
  assert.equal(r.questions.length, 1, JSON.stringify(r.questions));
  assert.equal(r.final, final);
  assert.equal(r.llm.exhausted, false);
  assert.equal((await waitFacts(run, "payment", 1, 1_500)).length, 0, "после «нет» денег не списано");
});
