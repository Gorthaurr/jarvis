// W1-D6 (стенд), сторона страницы: гард §14 судит подпись элемента только по ВИДИМЫМ источникам (aria/title/текст/
// value кнопки), не по типу, имени поля или селектору. Кнопка навигации теста Moodle `input type=submit name=next`
// «Следующая страница» — обычный переход (ответы сохраняются), а не сдача: гард LMS её пропускает; сдача «Отправить всё
// и завершить тест» — по-прежнему commit_confirm. Настоящий Chromium, настоящий регэксп сервера (serverGuardSource).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, serverGuardSource } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["robustClickMain", "elementActIsolated"]);
const GUARD = serverGuardSource();

describe("§14 на странице: подпись — видимая, не type=submit/name/селектор", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });

  it("«Следующая страница» (input type=submit name=next) под гардом LMS — клик уходит, форма попытки отправлена", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const r = await page.call(fns.robustClickMain, { selector: "#mod_quiz-next-nav", guard: GUARD });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("window.__submits.length"), 1);
  });

  it("Enter в поле ответа (кнопка отправки формы — «Следующая страница») — без commit_confirm", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const r = await page.callIsolated(fns.elementActIsolated, null, "key", { selector: "#q145678\\:4_answer", combo: "Enter", guard: GUARD });
    assert.notEqual(r.code, "commit_confirm", JSON.stringify(r));
  });

  it("сдача «Отправить всё и завершить тест» под тем же гардом — commit_confirm с видимой подписью, клика нет", async () => {
    await page.open(fixtureUrl("moodle-summary.html"));
    const r = await page.call(fns.robustClickMain, { text: "Отправить всё и завершить тест", guard: GUARD });
    assert.deepEqual([r.ok, r.code, r.label], [false, "commit_confirm", "Отправить всё и завершить тест"], JSON.stringify(r));
    assert.equal(await page.eval("window.__opened || 0"), 0);
  });
});
