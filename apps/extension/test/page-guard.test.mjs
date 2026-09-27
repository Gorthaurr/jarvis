// §14 на странице для ВСЕХ жестов отправки (адверс-ревью W1: EXT-1..4, EXT-7, EXT-9) — в настоящем Chromium, в
// изолированном мире расширения. Каждый тест проверен реверт-мутацией (снят гард → тест красный).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, serverGuardSource } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["inspectPageInPage", "elementActIsolated", "robustClickMain"]);
const GUARD = serverGuardSource();
// Журнал клавиш с модификаторами (фикстурный пишет только Ctrl) — ставится до действия.
const LOG_KEYS = "window.__k = []; document.addEventListener('keydown', (e) => window.__k.push([e.key, e.ctrlKey, e.shiftKey, e.altKey, e.metaKey].join(',')), true)";

describe("§14: Enter-жесты и переключатели судятся гардом", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const act = (intent, params, ref = null) => page.callIsolated(fns.elementActIsolated, ref, intent, params);
  const refOf = async (selector) => (await page.callIsolated(fns.inspectPageInPage, "", 200)).elements.find((e) => e.selector === selector)?.ref;

  for (const [name, intent, params] of [
    ["key Enter в поле", "key", { selector: "#msg", combo: "Enter" }],
    ["key Ctrl+Enter в поле", "key", { selector: "#msg", combo: "Ctrl+Enter" }],
    ["key Meta+Enter в поле", "key", { selector: "#msg", combo: "Meta+Enter" }],
    ["key Shift+Enter в поле", "key", { selector: "#msg", combo: "Shift+Enter" }],
    ["intent enter", "enter", { selector: "#msg" }],
    ["intent submit", "submit", { selector: "#msg" }],
  ]) {
    it(`${name}: форма «Отправить» → commit_confirm, клавиша до страницы не дошла, форма не ушла`, async () => {
      await page.open(fixtureUrl("form.html"));
      await page.eval(LOG_KEYS);
      const r = await act(intent, { ...params, guard: GUARD });
      assert.equal(r.code, "commit_confirm", JSON.stringify(r));
      assert.equal(r.label, "Отправить");
      assert.deepEqual(await page.eval("[window.__c.guarded, window.__k.length]"), [0, 0]);
    });
  }

  it("Ctrl+Enter после одобрения — уходит с настоящим ctrlKey, без сабмита формы браузером", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval(LOG_KEYS);
    const r = await act("key", { selector: "#msg", combo: "Ctrl+Enter", guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await page.eval("window.__k"), ["Enter,true,false,false,false"]);
  });

  it("Shift+Enter (перевод строки) без гарда: keydown с shiftKey, форма НЕ отправлена, не рапортуем submitted", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval(LOG_KEYS);
    const r = await act("key", { selector: "#q", combo: "Shift+Enter" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.notEqual(r.submitted, true);
    assert.deepEqual(await page.eval("window.__k"), ["Enter,false,true,false,false"]);
    assert.equal(await page.eval("window.__c.search"), 0);
  });

  it("type{enter:'false'} (строка) — Enter не жмётся: жест только при строгом true", async () => {
    await page.open(fixtureUrl("form.html"));
    const r = await act("type", { selector: "#q", text: "кот", enter: "false", submit: "false" });
    assert.deepEqual([r.ok, r.submitted], [true, false]);
    assert.equal(await page.eval("window.__c.search"), 0);
  });

  it("set галочки «Опубликовать профиль» (по ref) → commit_confirm, не переключена; после одобрения — да", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.getElementById('profile').insertAdjacentHTML('beforeend', '<input type=checkbox id=pub><label for=pub>Опубликовать профиль</label>')");
    const ref = await refOf("#pub");
    const no = await act("set", { checked: true, guard: GUARD }, ref);
    assert.equal(no.code, "commit_confirm", JSON.stringify(no));
    assert.equal(await page.eval("document.getElementById('pub').checked"), false);
    const yes = await act("set", { checked: true, guard: GUARD, guardApproved: true, approvedLabel: no.label }, ref);
    assert.equal(yes.ok, true, JSON.stringify(yes));
    assert.equal(await page.eval("document.getElementById('pub').checked"), true);
  });

  it("set role=switch «Оплатить автоматически» по подписи → commit_confirm, aria-checked не тронут", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("const s = document.getElementById('dark'); s.textContent = 'Оплатить автоматически'");
    const r = await act("set", { text: "Оплатить автоматически", checked: true, guard: GUARD });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('dark').getAttribute('aria-checked')"), "false");
  });

  it("set обычной галочки в форме с кнопкой «Отправить» — НЕ вопрос (переключение не отправляет форму)", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.getElementById('guarded').insertAdjacentHTML('afterbegin', '<input type=checkbox id=agree><label for=agree>Запомнить меня</label>')");
    const r = await act("set", { selector: "#agree", checked: true, guard: GUARD });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it("одобрили «Отправить», а Enter судится по «Отправить перевод 50 000 ₽» — снова вопрос, форма не ушла", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.querySelector('#guarded button').textContent = 'Отправить перевод 50 000 ₽'");
    const r = await act("key", { selector: "#msg", combo: "Enter", guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("window.__c.guarded"), 0);
  });

  it("клик: одобрили «Отправить», а кнопка «Отправить перевод 50 000 ₽» — снова вопрос, клика нет", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.body.insertAdjacentHTML('afterbegin', '<button id=bb onclick=\"window.__b=1\">Отправить перевод 50 000 ₽</button>')");
    const r = await page.call(fns.robustClickMain, { selector: "#bb", guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("window.__b || 0"), 0);
  });
});

describe("seek по ref: только медиа самой цели (EXT-9)", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });

  it("ref карточки без медиа → not_found, чужой первый плеер не перематывается", async () => {
    await page.open(fixtureUrl("media.html"));
    for (let i = 0; i < 100 && !(await page.eval("document.getElementById('player').duration > 0")); i++) await new Promise((r) => setTimeout(r, 50));
    const ref = (await page.callIsolated(fns.inspectPageInPage, "", 200)).elements.find((e) => e.selector === "#next")?.ref;
    assert.ok(ref, "нет ref кнопки");
    const r = await page.callIsolated(fns.elementActIsolated, ref, "seek", { to: 1 });
    assert.equal(r.code, "not_found", JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('player').currentTime"), 0);
  });
});
