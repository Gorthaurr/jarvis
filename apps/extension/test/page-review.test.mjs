// Находки адверс-ревью 26.09 — каждая воспроизведена на странице в настоящем Chromium. Запуск: node --test "apps/extension/test/*.test.mjs"
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { findChrome, fixtureUrl, launchPage, pageFunctionSources, serverGuardSource } from "./cdp-harness.mjs";

const fns = pageFunctionSources(["robustClickMain", "inspectPageInPage", "pageActInPage", "actByRefIsolated", "readPageInPage"]);
const GUARD = serverGuardSource();

describe("ревью 26.09: гард коммита, select, снимок", { skip: !findChrome() && "нет Chrome" }, () => {
  let page;
  before(async () => { page = await launchPage(); });
  after(async () => { await page?.close(); });
  const click = (params) => page.call(fns.robustClickMain, params);
  const act = (intent, params) => page.call(fns.pageActInPage, intent, params);

  it("гард видит подпись из aria-labelledby и из alt картинки (кнопка-иконка)", async () => {
    await page.open(fixtureUrl("plain.html"));
    for (const selector of ["#send-icon", "#pay-img"]) {
      const r = await click({ selector, guard: GUARD });
      assert.equal(r.code, "commit_confirm", `${selector}: ${JSON.stringify(r)}`);
    }
  });

  it("гард ловит якорное LMS-слово, даже когда title повторяет текст («Сохранить Сохранить»)", async () => {
    await page.open(fixtureUrl("plain.html"));
    const r = await click({ selector: "#save-dup", guard: GUARD });
    assert.equal(r.code, "commit_confirm");
    assert.equal(r.label, "Сохранить");
  });

  it("одобрение привязано к подписи: одобрили «Отправить», а селектор бьёт в «Оплатить 50 000 ₽» — снова вопрос", async () => {
    await page.open(fixtureUrl("plain.html"));
    const miss = await click({ selector: "#pay-now", guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    assert.equal(miss.code, "commit_confirm");
    const hit = await click({ selector: "#send-now", guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    assert.equal(hit.ok, true);
  });

  it("немодальный role=dialog (cookie-баннер) не забирает клик у одноимённой ссылки страницы", async () => {
    await page.open(fixtureUrl("plain.html"));
    await click({ text: "Подробнее" });
    assert.equal(await page.eval("location.hash"), "#details");
  });

  it("пароль, введённый владельцем, не уходит в снимок ни текстом, ни подписью", async () => {
    await page.open(fixtureUrl("plain.html"));
    // Контроль: и «показанный» пароль (type=text + autocomplete=current-password), и составной «billing cc-number».
    await page.eval("document.getElementById('pw').value = 'S3cret!pass'; document.getElementById('pw-shown').value = 'S3cretShown'; document.getElementById('card').value = '4111111111111111'");
    for (const refMode of [false, true]) {
      const snap = JSON.stringify(await page.call(fns.inspectPageInPage, "", 200, refMode));
      assert.ok(!snap.includes("S3cret"), `refMode=${refMode}: пароль в снимке`);
      assert.ok(!snap.includes("4111111111111111"), `refMode=${refMode}: номер карты в снимке`);
    }
  });

  it("повторяющиеся id карточек: селекторы уникальны или честно помечены ambiguous", async () => {
    await page.open(fixtureUrl("plain.html"));
    const els = (await page.call(fns.inspectPageInPage, "Видео", 200, false)).elements.filter((e) => e.tag === "a");
    assert.equal(els.length, 3);
    for (const e of els) {
      const n = await page.eval(`document.querySelectorAll(${JSON.stringify(e.selector)}).length`);
      assert.ok(n === 1 || e.ambiguous === true, `${e.text}: ${e.selector} → ${n} узлов без пометки`);
    }
  });

  it("select: одинаковые value — выбирается пункт по тексту, readback — реально выбранный", async () => {
    await page.open(fixtureUrl("plain.html"));
    const r = await act("select", { selector: "#dup", option: "Берлин" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("document.getElementById('dup').selectedOptions[0].text"), "Берлин");
    assert.equal(r.value, "Берлин");
  });

  it("select multiple: новый пункт добавляется, прежние не сбрасываются", async () => {
    await page.open(fixtureUrl("plain.html"));
    const r = await act("select", { selector: "#multi", option: "Rust" });
    assert.equal(r.ok, true);
    assert.deepEqual(await page.eval("[...document.getElementById('multi').selectedOptions].map(o => o.text)"), ["Python", "Go", "Rust"]);
  });

  it("select по ref: текст варианта важнее value («2» — это вариант с текстом 2, а не value=2)", async () => {
    await page.open(fixtureUrl("plain.html"));
    const sel = (await page.call(fns.inspectPageInPage, "", 200, true)).elements.find((e) => /#num|num/.test(e.selector) && e.role === "select");
    assert.ok(sel?.ref, "нет ref у #num");
    const r = await page.call(fns.actByRefIsolated, sel.ref, "select", { option: "2" });
    assert.equal(r.ok, true);
    assert.equal(await page.eval("document.getElementById('num').selectedOptions[0].text"), "2");
  });

  it("формулы TeX идут В НАЧАЛЕ текста (хвост режут расширение и сервер)", async () => {
    await page.open(fixtureUrl("moodle-attempt.html"));
    const r = await page.call(fns.readPageInPage, "");
    assert.match(r.text.slice(0, 200), /\\frac\{a\}\{b\}/u);
  });
});
