// §14 на странице (W1-ревью р2): все кнопки отправки формы, next/prev без ref, список с действием на change, set по
// обёртке, Enter-фолбэк встряхивания — в настоящем Chromium с НАСТОЯЩИМ регэкспом гарда сервера. Реверт-проверены.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, serverGuardSource } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["inspectPageInPage", "elementActIsolated", "robustClickMain", "pageActInPage"]);
const GUARD = serverGuardSource();

describe("§14: формы, списки, обёртки, next/prev, встряхивание", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const act = (intent, params, ref = null) => page.callIsolated(fns.elementActIsolated, ref, intent, { ...params, guard: GUARD });
  const count = (k) => page.eval(`window.__c.${k}`);

  for (const [name, intent, params, form, label] of [
    ["type+enter: первая кнопка «Применить», вторая «Оплатить заказ»", "type", { selector: "#holder", text: "IVAN", enter: true }, "chk", "Оплатить заказ"],
    ["submit в той же форме", "submit", { selector: "#holder" }, "chk", "Оплатить заказ"],
    ["enter: единственная кнопка формы — вне её (form=id)", "enter", { selector: "#holder2" }, "chk2", "Оплатить"],
  ]) {
    it(`${name} → commit_confirm «${label}», форма не ушла`, async () => {
      await page.open(fixtureUrl("approve.html"));
      const r = await act(intent, params);
      assert.equal(r.code, "commit_confirm", JSON.stringify(r));
      assert.equal(r.label, label);
      assert.equal(await count(form), 0);
    });
  }

  it("next без ref: «Далее: оплатить заказ 50 000 ₽» → commit_confirm; после одобрения подписи — клик", async () => {
    await page.open(fixtureUrl("approve.html"));
    const no = await page.callIsolated(fns.pageActInPage, "next", { guard: GUARD });
    assert.equal(no.code, "commit_confirm", JSON.stringify(no));
    assert.equal(await count("nextpay"), 0);
    const bare = await page.callIsolated(fns.pageActInPage, "next", { guard: GUARD, guardApproved: true });
    assert.equal(bare.code, "commit_confirm", "guardApproved без подписи — не одобрение");
    const yes = await page.callIsolated(fns.pageActInPage, "next", { guard: GUARD, guardApproved: true, approvedLabel: no.label });
    assert.equal(yes.ok, true, JSON.stringify(yes));
    assert.equal(await count("nextpay"), 1);
  });

  for (const intent of ["set", "select"]) {
    it(`${intent} на <select> «Удалить навсегда» → commit_confirm, change не случился; одобрили — выбран`, async () => {
      await page.open(fixtureUrl("approve.html"));
      const params = intent === "set" ? { selector: "#bulk", value: "Удалить навсегда" } : { selector: "#bulk", option: "Удалить навсегда" };
      const no = await act(intent, params);
      assert.equal(no.code, "commit_confirm", JSON.stringify(no));
      assert.equal(no.label, "Удалить навсегда");
      assert.deepEqual(await page.eval("[window.__c.bulk, document.getElementById('bulk').value]"), [0, "Выберите"]);
      const yes = await act(intent, { ...params, guardApproved: true, approvedLabel: no.label });
      assert.equal(yes.ok, true, JSON.stringify(yes));
      assert.equal(await count("bulk"), 1);
    });
  }

  it("set безобидной опции в списке без слов-коммитов — не вопрос", async () => {
    await page.open(fixtureUrl("approve.html"));
    const r = await act("set", { selector: "#bulk", value: "Пометить прочитанным" });
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it("set по ref обёртки «Опубликовать профиль» с безымянным переключателем внутри → commit_confirm, не переключён", async () => {
    await page.open(fixtureUrl("approve.html"));
    const ref = (await page.callIsolated(fns.inspectPageInPage, "", 200)).elements.find((e) => e.selector === "#row")?.ref;
    assert.ok(ref, "нет ref обёртки");
    const r = await act("set", { checked: true }, ref);
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(await page.eval("document.getElementById('sw').getAttribute('aria-checked')"), "false");
  });

  it("встряхивание по полю-композеру: Enter-фолбэк в поле не жмётся (сообщение не ушло), честный no_effect", async () => {
    await page.open(fixtureUrl("approve.html"));
    const r = await page.call(fns.robustClickMain, { selector: "#comp2", text: "обновить", expectChange: true, guard: GUARD });
    assert.equal(r.code, "no_effect", JSON.stringify(r));
    assert.equal(await count("comp2"), 0);
  });

  it("встряхивание по кнопке в форме «Оплатить заказ»: Enter-фолбэк — жест отправки, гард спрашивает до действия", async () => {
    await page.open(fixtureUrl("approve.html"));
    const r = await page.call(fns.robustClickMain, { selector: "#apply", text: "обновить", expectChange: true, guard: GUARD });
    assert.equal(r.code, "commit_confirm", JSON.stringify(r));
    assert.equal(r.label, "Оплатить заказ");
    assert.equal(await count("chk"), 0);
  });
});
