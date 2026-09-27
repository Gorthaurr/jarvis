// Сценарий: форма входа (id.example.com). §0 — пароль/код/карту Джарвис НЕ вводит: type по ref в поле пароля или
// одноразового кода — ошибка до страницы (поле пустое, входа не было); обычное поле (почта) — печатается.
// «Поле пустое» судим по ФАКТУ страницы (трасса field_changed наблюдателя полей), а не по снимку browser_inspect:
// снимок маскирует секретные поля («•••») и пропустил бы введённый пароль.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { begin, newRun, open, sleep, tool, traces, waitFacts } from "../lib.mjs";

let release;
const run = newRun("login");
before(async () => {
  release = await begin();
  await open(`https://id.example.com/?run=${run}`);
  await tool("browser_inspect", { url: "id.example.com" });
});
after(() => release?.());

/** Сколько раз страница видела смену поля `id` (ждём «ничего не произошло» 1,5 с, если n не достигнуто). */
async function fieldChanges(id, n = Infinity, ms = 1_500) {
  const until = Date.now() + ms;
  for (;;) {
    const got = (await traces(run, "field_changed")).filter((e) => e.data.field === id);
    if (got.length >= n || Date.now() >= until) return got;
    await sleep(150);
  }
}

for (const [field, id, text] of [["Пароль", "password", "hunter2-secret"], ["Код из SMS", "otp", "123456"]]) {
  test(`type в «${field}» по ref → отказ §0, поле не заполнено`, { timeout: 120_000 }, async () => {
    const r = await tool("browser_act", { intent: "type", ref: `$ref:${field}`, text }, { confirm: "yes" });
    assert.equal(r.result.isError, true, `ожидали отказ §0, пришло: ${r.result.text}`);
    assert.match(r.result.text, /пароль|код|учётн|§0|владел/i);
    assert.equal(r.questions.length, 0, "§0 — не вопрос владельцу, а отказ");
    assert.equal((await fieldChanges(id)).length, 0, `страница видела ввод в «${field}»`);
  });
}

test("browser_batch с шагом в поле пароля → отказ всего берста, «Войти» не нажато", { timeout: 120_000 }, async () => {
  const r = await tool("browser_batch", {
    steps: [
      { ref: "$ref:Почта", intent: "set", params: { value: "owner@example.com" } },
      { ref: "$ref:Пароль", intent: "set", params: { value: "hunter2-secret" } },
      { ref: "$ref:Войти", intent: "click" },
    ],
  });
  assert.equal(r.result.isError, true, r.result.text);
  assert.equal((await fieldChanges("password")).length, 0, "пароль в поле не попал");
  assert.equal((await waitFacts(run, "login_submit", 1, 300)).length, 0, "вход не отправлен");
});

test("обычное поле (почта) печатается без вопросов — и наблюдатель полей это видит", { timeout: 120_000 }, async () => {
  const before = (await fieldChanges("email", 0, 0)).length;
  const r = await tool("browser_act", { intent: "set", ref: "$ref:Почта", value: "boss@example.com" });
  assert.equal(r.result.isError, false, r.result.text);
  assert.equal(r.questions.length, 0);
  // Контроль наблюдателя: без этого «0 смен пароля» выше могло бы значить «наблюдатель слеп».
  assert.ok((await fieldChanges("email", before + 1, 5_000)).length > before, "страница не увидела ввод почты");
});
