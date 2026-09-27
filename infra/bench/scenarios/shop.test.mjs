// Сценарий: безопасный хост (shop.example.com). Клик по ref «Добавить в корзину» — без вопроса владельцу, факт
// cart_add ровно один; берст [set количества, click] — один раунд; «Оформить заказ» — страничный гард W1 узнаёт
// коммит (оформ…) на ЛЮБОМ хосте: «нет» → заказа нет, «да» → ровно один заказ.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { begin, newRun, open, sleep, tool, waitFacts } from "../lib.mjs";

const run = newRun("shop");
let release;
before(async () => {
  release = await begin();
  await open(`https://shop.example.com/?run=${run}`);
});
after(() => release?.());

test("inspect → ref → клик «Добавить в корзину» без вопроса; в корзину ровно один раз", { timeout: 120_000 }, async () => {
  const insp = await tool("browser_inspect", { url: "shop.example.com" });
  assert.equal(insp.result.isError, false, insp.result.text);
  assert.match(insp.result.text, /Добавить в корзину/);
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Добавить в корзину" }, { confirm: "no" });
  assert.equal(r.result.isError, false, r.result.text);
  assert.equal(r.questions.length, 0, "на безопасном хосте «в корзину» — без вопроса владельцу");
  const got = await waitFacts(run, "cart_add", 1);
  await sleep(1_000);
  assert.equal((await waitFacts(run, "cart_add", 2, 300)).length, 1, "ровно одно добавление");
  assert.equal(got[0].data.qty, 1);
});

test("browser_batch: [set количества 3, click] — один вызов, 0 вопросов, cart_add{qty:3}", { timeout: 120_000 }, async () => {
  await tool("browser_inspect", { url: "shop.example.com" });
  const r = await tool("browser_batch", {
    steps: [
      { ref: "$ref:Количество", intent: "set", params: { value: "3" } },
      { ref: "$ref:Добавить в корзину", intent: "click" },
    ],
  });
  assert.equal(r.result.isError, false, r.result.text);
  assert.equal(r.questions.length, 0);
  const adds = await waitFacts(run, "cart_add", 2);
  assert.equal(adds.length, 2, "первое добавление + берст");
  assert.equal(adds[1].data.qty, 3, "берст выставил количество 3 до клика");
});

test("«Оформить заказ» «нет» → ровно 1 вопрос, заказа нет; «да» → ровно один заказ", { timeout: 120_000 }, async () => {
  await tool("browser_inspect", { url: "shop.example.com" });
  const no = await tool("browser_act", { intent: "click", ref: "$ref:Оформить заказ" }, { confirm: "no" });
  assert.equal(no.questions.length, 1, `вопросы: ${JSON.stringify(no.questions)}`);
  assert.equal(no.result.flags.declined, true, no.result.text);
  assert.equal((await waitFacts(run, "order_placed", 1, 1_500)).length, 0, "после «нет» заказа нет");
  const yes = await tool("browser_act", { intent: "click", ref: "$ref:Оформить заказ" }, { confirm: "yes" });
  assert.equal(yes.questions.length, 1, `вопросы: ${JSON.stringify(yes.questions)}`);
  assert.equal((await waitFacts(run, "order_placed", 1)).length, 1);
  await sleep(1_000);
  assert.equal((await waitFacts(run, "order_placed", 2, 300)).length, 1, "ровно один заказ");
});
