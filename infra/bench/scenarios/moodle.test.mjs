// Сценарий: Moodle (lms.vuz-bench.ru, опасное место — по ПУТИ /mod/quiz/*). Старт попытки тратит лимит попыток —
// только с «да»; ответы и переходы по страницам — обычная работа (без вопроса); «Отправить всё и завершить тест»
// (кнопка → модалка с ТОЙ ЖЕ подписью) — ОДИН вопрос на связку. Факт: попытка ровно одна, сдача ровно одна.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { begin, newRun, open, sleep, tool, waitFacts } from "../lib.mjs";
import { waitsFix } from "./defects.mjs";

let release;
before(async () => {
  release = await begin();
});
after(() => release?.());

/** browser_inspect, пока вкладка не дошла до страницы `re` (клик уводит страницу — ждём, а не бьём в старую). */
async function inspectAt(re, query) {
  for (let i = 0; i < 40; i += 1) {
    const r = await tool("browser_inspect", { url: "lms.vuz-bench.ru", ...(query ? { query } : {}) });
    if (!r.result.isError && re.test(r.result.text)) return r;
    await sleep(250);
  }
  throw new Error(`вкладка не дошла до ${re}`);
}

async function viewQuiz() {
  const run = newRun("lms");
  await open(`https://lms.vuz-bench.ru/mod/quiz/view.php?id=5&run=${run}`);
  await inspectAt(/view\.php/);
  return run;
}

test("«Начать попытку» + «нет» → вопрос, попытка НЕ начата", { timeout: 120_000 }, async () => {
  const run = await viewQuiz();
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Начать попытку" }, { confirm: "no" });
  assert.ok(r.questions.length >= 1, "старт попытки — только с вопросом");
  assert.match(r.questions[0].summary, /учебная система/);
  assert.equal((await waitFacts(run, "attempt_started", 1, 1_500)).length, 0);
});

test("весь тест на «да»: попытка ровно одна, ответы сохранены, сдача ровно одна", { timeout: 180_000 }, async () => {
  const run = await viewQuiz();
  await tool("browser_act", { intent: "click", ref: "$ref:Начать попытку" }, { confirm: "yes" });
  assert.equal((await waitFacts(run, "attempt_started", 1)).length, 1);
  for (const [page, answer] of [[0, "c. Париж"], [1, "b. 4"]]) {
    await inspectAt(new RegExp(`attempt\\.php\\?attempt=\\d+&page=${page}`));
    await tool("browser_act", { intent: "click", ref: `$ref:${answer}` });
    await tool("browser_act", { intent: "click", ref: page === 0 ? "$ref:Следующая страница" : "$ref:Закончить попытку..." }, { confirm: "yes" });
  }
  await inspectAt(/summary\.php/);
  await tool("browser_act", { intent: "click", ref: "$ref:Отправить всё и завершить тест" }, { confirm: "yes" });
  const modal = await inspectAt(/summary\.php/, "отправить всё и завершить тест");
  const refs = [...modal.result.text.matchAll(/"name":"Отправить всё и завершить тест","ref":"([^"]+)"/g)].map((m) => m[1]);
  await tool("browser_act", { intent: "click", ref: refs[refs.length - 1] }, { confirm: "yes" });
  assert.equal((await waitFacts(run, "quiz_finished", 1)).length, 1, "тест сдан");
  await sleep(1_000);
  assert.equal((await waitFacts(run, "attempt_started", 2, 300)).length, 1, "попытка ровно одна");
  assert.equal((await waitFacts(run, "answer_saved", 3, 300)).length, 2, "оба ответа сохранены");
  assert.equal((await waitFacts(run, "quiz_finished", 2, 300)).length, 1, "сдача ровно одна");
});

test("«Начать попытку» + «да» → ровно ОДИН вопрос", waitsFix("DOUBLE_CONFIRM"), async () => {
  await viewQuiz();
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Начать попытку" }, { confirm: "yes" });
  assert.equal(r.questions.length, 1, r.questions.map((q) => q.summary).join(" | "));
});

test("переход «Следующая страница» внутри попытки — без вопроса владельцу", waitsFix("LMS_NAV_ASKS"), async () => {
  const run = await viewQuiz();
  await tool("browser_act", { intent: "click", ref: "$ref:Начать попытку" }, { confirm: "yes" });
  await inspectAt(/attempt\.php/);
  await tool("browser_act", { intent: "click", ref: "$ref:c. Париж" });
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Следующая страница" }, { confirm: "no" });
  assert.equal(r.questions.length, 0, r.questions.map((q) => q.summary).join(" | "));
  assert.equal((await waitFacts(run, "answer_saved", 1)).length, 1);
});

test("сдача в два шага (кнопка → модалка) — один вопрос на связку", waitsFix("LMS_TWO_STEP"), async () => {
  const run = await viewQuiz();
  await tool("browser_act", { intent: "click", ref: "$ref:Начать попытку" }, { confirm: "yes" });
  const attempt = (await waitFacts(run, "attempt_started", 1))[0].data.attempt;
  await open(`https://lms.vuz-bench.ru/mod/quiz/summary.php?attempt=${attempt}&run=${run}`);
  await inspectAt(/summary\.php/);
  const first = await tool("browser_act", { intent: "click", ref: "$ref:Отправить всё и завершить тест" }, { confirm: "yes" });
  const modal = await inspectAt(/summary\.php/, "отправить всё и завершить тест");
  const refs = [...modal.result.text.matchAll(/"name":"Отправить всё и завершить тест","ref":"([^"]+)"/g)].map((m) => m[1]);
  const second = await tool("browser_act", { intent: "click", ref: refs[refs.length - 1] }, { confirm: "no" });
  assert.equal((await waitFacts(run, "quiz_finished", 1)).length, 1, "одного «да» хватило на связку");
  assert.equal(first.questions.length + second.questions.length, 1);
});
