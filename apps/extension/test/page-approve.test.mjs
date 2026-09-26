// Контракт одобрения §14 (W1-ревью р2, NEW-1) на странице, в настоящем Chromium. Одобрено, если (a) цель по ref и это
// одобренный ref; (b) сложенная часть подписи цели РАВНА одобренной; (c) — та, что страница сама вернула в
// commit_confirm (она и есть часть). Ни подстрока, ни обрезка, ни P.text модели не одобряют. Одобрение в форме,
// которую реально шлёт сервер: approvedLabel = видимое имя из снимка (не склейка хинта), approvedRef = ref цели.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, serverGuardSource, swOnPage } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["inspectPageInPage", "elementActIsolated", "robustClickMain"]);
const GUARD = serverGuardSource();
const OK = { guard: GUARD, guardApproved: true };

describe("одобрение §14: один вопрос на шаг по ref (NEW-1)", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const act = (intent, params, ref = null) => page.callIsolated(fns.elementActIsolated, ref, intent, params);
  const click = (params) => page.call(fns.robustClickMain, params);
  const snapOf = async (selector) => (await page.callIsolated(fns.inspectPageInPage, "", 200)).elements.find((e) => e.selector === selector);

  it("type+enter по ref в поле формы «Отправить»: имя поля + ref → с первого «да»; склейка хинта без ref — снова вопрос", async () => {
    await page.open(fixtureUrl("form.html"));
    const el = await snapOf("#msg");
    const hint = [el.name, el.selector, el.role, el.type].join(" "); // прежняя подпись одобрения (browser-refs, W1-T9)
    const stale = await act("type", { text: "привет", enter: true, ...OK, approvedLabel: hint, ref: el.ref }, el.ref);
    assert.equal(stale.code, "commit_confirm", JSON.stringify(stale));
    const r = await act("type", { text: "привет", enter: true, ...OK, approvedLabel: el.name, approvedRef: el.ref, ref: el.ref }, el.ref);
    assert.deepEqual([r.ok, r.submitted], [true, true], JSON.stringify(r));
    assert.equal(await page.eval("window.__c.guarded"), 1);
  });

  it("(a) одобрен ref цели — Enter проходит без подписи; чужой ref и guardApproved без подписи и ref — не одобрение", async () => {
    await page.open(fixtureUrl("form.html"));
    const [msg, q] = [await snapOf("#msg"), await snapOf("#q")];
    const other = await act("key", { combo: "Enter", ...OK, approvedRef: q.ref, ref: msg.ref }, msg.ref);
    assert.equal(other.code, "commit_confirm", JSON.stringify(other));
    const bare = await act("key", { selector: "#msg", combo: "Enter", ...OK });
    assert.equal(bare.code, "commit_confirm", JSON.stringify(bare));
    assert.equal(await page.eval("window.__c.guarded"), 0);
    const own = await act("key", { combo: "Enter", ...OK, approvedLabel: "не та подпись", approvedRef: msg.ref, ref: msg.ref }, msg.ref);
    assert.deepEqual([own.ok, own.submitted], [true, true], JSON.stringify(own));
    assert.equal(await page.eval("window.__c.guarded"), 1);
  });

  it("ext-regress-1 / srv-regress-2: поля без слов-коммитов — несовпавшее одобрение не рождает второй вопрос", async () => {
    await page.open(fixtureUrl("approve.html"));
    const chat = await act("key", { selector: "#chatbox", combo: "Enter", ...OK, approvedLabel: "Сообщение #chatbox textarea" });
    assert.deepEqual([chat.ok, chat.submitted], [true, true], JSON.stringify(chat));
    const yt = await act("type", { selector: "#ytq", text: "котики", enter: true, ...OK, approvedLabel: "Поиск #ytq input text" });
    assert.deepEqual([yt.ok, yt.submitted], [true, true], JSON.stringify(yt));
    assert.deepEqual(await page.eval("[window.__c.chatbox, window.__c.yt]"), [1, 1]);
  });

  it("ext-regress-2: клик по ref «Оплатить заказ» (маршрут SW) — одобрение ref-ом проходит сразу, чужой ref — вопрос", async () => {
    await page.open(fixtureUrl("approve.html"));
    const { env } = swOnPage(page);
    const snap = await env.tabInspect("", "", 200, 1);
    const [pay, act2] = ["#pay", "#act"].map((s) => snap.elements.find((e) => e.selector === s));
    await assert.rejects(env.tabAct("", "click", { ref: pay.ref, ...OK, approvedLabel: "Оплатить заказ #pay button", approvedRef: act2.ref }, 1), (e) => e.code === "commit_confirm");
    assert.equal(await page.eval("window.__c.pay"), 0);
    const r = await env.tabAct("", "click", { ref: pay.ref, ...OK, approvedLabel: pay.name, approvedRef: pay.ref }, 1);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("window.__c.pay"), 1);
    // Идентичность по ref: SW доносит ref и approvedRef до MAIN-мира — одобрение держится и без совпадения подписи.
    const byRef = await env.tabAct("", "click", { ref: pay.ref, ...OK, approvedRef: pay.ref }, 1);
    assert.equal(byRef.ok, true, JSON.stringify(byRef));
    assert.equal(await page.eval("window.__c.pay"), 2);
  });

  it("(c) подпись, которую страница вернула сама, одобряет повтор: вторая кнопка формы «Оплатить заказ»", async () => {
    await page.open(fixtureUrl("approve.html"));
    const no = await act("type", { selector: "#holder", text: "IVAN", enter: true, guard: GUARD });
    assert.equal(no.label, "Оплатить заказ", JSON.stringify(no));
    const yes = await act("type", { selector: "#holder", text: "IVAN", enter: true, ...OK, approvedLabel: no.label });
    assert.equal(yes.ok, true, JSON.stringify(yes));
    assert.equal(await page.eval("window.__c.chk"), 1);
  });
});

describe("одобрение §14: ни шорткат P.text, ни подстрока, ни обрезка", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const act = (intent, params, ref = null) => page.callIsolated(fns.elementActIsolated, ref, intent, params);
  const click = (params) => page.call(fns.robustClickMain, params);

  it("submit{text:'Отправить'} с одобрением «Отправить», а кнопка «Отправить перевод 50 000 ₽» — вопрос, форма не ушла", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.querySelector('#guarded button').textContent = 'Отправить перевод 50 000 ₽'");
    const r = await act("submit", { text: "Отправить", ...OK, approvedLabel: "Отправить" });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("window.__c.guarded"), 0);
  });

  it("set{text:'Опубликовать'} с одобрением «Опубликовать» на «Опубликовать и разослать всем» — вопрос (srv-bypass-7)", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.getElementById('dark').textContent = 'Опубликовать и разослать всем'");
    const r = await act("set", { text: "Опубликовать", checked: true, ...OK, approvedLabel: "Опубликовать" });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('dark').getAttribute('aria-checked')"), "false");
  });

  it("битый guard — не «гарда нет»: отказ, ничего не нажато (fail-closed)", async () => {
    await page.open(fixtureUrl("form.html"));
    const k = await act("key", { selector: "#msg", combo: "Enter", guard: "(" });
    assert.equal(k.ok, false, JSON.stringify(k));
    await assert.rejects(click({ selector: "#guarded button", guard: "(" }));
    assert.deepEqual(await page.eval("[window.__c.guarded, window.__c.keys.length]"), [0, 0]);
  });

  it("длинная подпись: одобрены первые 120 символов — вопрос; одобрена вся — клик (без обрезки)", async () => {
    await page.open(fixtureUrl("approve.html"));
    const full = await page.eval("document.getElementById('long').innerText");
    const cut = await click({ selector: "#long", ...OK, approvedLabel: full.slice(0, 120) });
    assert.equal(cut.code, "commit_confirm", JSON.stringify(cut));
    assert.equal(cut.label, full);
    const r = await click({ selector: "#long", ...OK, approvedLabel: cut.label });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("window.__c.long"), 1);
  });

  it("длинная кнопка отправки формы (> 200 символов): одобрены первые 200 — вопрос; вся — форма ушла", async () => {
    await page.open(fixtureUrl("approve.html"));
    const full = await page.eval("document.getElementById('longsub').innerText");
    const cut = await act("enter", { selector: "#lfq", ...OK, approvedLabel: full.slice(0, 200) });
    assert.equal(cut.code, "commit_confirm", JSON.stringify(cut));
    assert.equal(cut.label, full);
    const r = await act("enter", { selector: "#lfq", ...OK, approvedLabel: cut.label });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.eval("window.__c.lf"), 1);
  });

  it("одобренная подпись ДЛИННЕЕ цели не одобряет: «Удалить черновик» ≠ «Удалить», «Отправить сейчас» ≠ «Отправить» (ext-tests-4)", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.body.insertAdjacentHTML('afterbegin', '<button id=rm onclick=\"window.__rm=1\">Удалить</button>')");
    const r = await click({ selector: "#rm", ...OK, approvedLabel: "Удалить черновик" });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("window.__rm || 0"), 0);
    const k = await act("key", { selector: "#msg", combo: "Enter", ...OK, approvedLabel: "Отправить сейчас" });
    assert.equal(k.code, "commit_confirm", JSON.stringify(k));
    assert.equal(await page.eval("window.__c.guarded"), 0);
  });

  it("set с одобрением ЧУЖОЙ подписи («Запомнить меня») на «Опубликовать профиль» — вопрос, не переключена (ext-tests-5)", async () => {
    await page.open(fixtureUrl("form.html"));
    await page.eval("document.getElementById('profile').insertAdjacentHTML('beforeend', '<input type=checkbox id=pub><label for=pub>Опубликовать профиль</label>')");
    const r = await act("set", { selector: "#pub", checked: true, ...OK, approvedLabel: "Запомнить меня" });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('pub').checked"), false);
  });
});
