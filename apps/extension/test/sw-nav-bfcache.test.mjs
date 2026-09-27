// Боевой прогон 27.09 (Moodle, прод-лог): browser_act click по «Вход» молчал 20 с до таймаута моста → isError, хотя вход
// прошёл. Механизм (проба на настоящем расширении): уходящий документ попадает в back/forward-кэш ЗАМОРОЖЕННЫМ — await
// robustClickMain после клика не завершается, executeScript не отвечает, пока страницу не вытеснят из кэша (минуты); с
// выключенным bfcache тот же клик отвечал за <1 с (W1-D1: пустой результат → pageLeftOutcome). Стенд — настоящий SW в
// настоящем Chrome по http (bfcache бывает только у http/https; file:// рвёт контекст — старый путь, он уже честный).
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { serverGuardSource } from "./cdp-harness.mjs";
import { launchExtension } from "./ext-harness.mjs";

const CAP = 12_000; // мост ждёт 20 с — зависание на замороженной странице кап ловит; фоновая вкладка троттлит таймеры до 1 с
const GUARD = serverGuardSource();
const posts = new Map();
const html = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;
const LOGIN = html("Вход", `<form method="post" action="/do-login"><input name="u" value="a"><button type="submit" id="go">Вход</button></form>
<form method="post" action="/do-send"><button type="submit" id="send">Отправить</button></form>
<form method="post" action="/do-slow"><button type="submit" id="slow">Сдать</button></form>
<a id="lnk" href="/home">Дальше</a><button id="noop" onclick="this.textContent='нажато'">Пусто</button>
<button id="fake" onclick="this.textContent='нажато';Promise.resolve().then(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')))">Подделка</button>`);

const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "POST") {
    posts.set(path, (posts.get(path) ?? 0) + 1);
    req.resume();
    // /do-slow — ответ сайта дольше ожидания клика (ревью р1): документ ещё на месте, вкладка уже грузится.
    req.on("end", () => setTimeout(() => { res.writeHead(303, { location: "/home" }); res.end(); }, path === "/do-slow" ? 2500 : 0));
    return;
  }
  const body = path === "/login" ? LOGIN : path === "/home" ? html("Главная", "<h1>Добро пожаловать</h1>") : null;
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ?? "");
});

let ext = null;
let base = "";
let seq = 0;

/** Свежая вкладка /login → tab.act как его шлёт сервер → ответ SW (с капом) и адрес вкладки после. */
async function act(intent, params) {
  const tabId = await ext.openTab(base + "/login");
  const { reply, ms } = await ext.reply({ id: "t" + ++seq, type: "tab.act", url: "", intent, params, tabId, refMode: true }, CAP);
  return { reply, ms, tab: await ext.tab(tabId) };
}

describe("tab.act click, уводящий страницу (bfcache), отвечает сразу и честно", { timeout: 120_000 }, () => {
  before(async () => {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    ext = await launchExtension();
    if (!ext) return;
    // Прогрев: первый уход страницы в сессии Chrome вытесняется из кэша за 2–6 с (проба) — боевой случай — последующие.
    await act("click", { selector: "#lnk" });
    posts.clear();
  });
  after(async () => {
    await ext?.close();
    server.close();
  });

  for (const [what, sel, path] of [["кнопка входа POST-формы", "#go", "/do-login"], ["ссылка", "#lnk", null]]) {
    it(`${what}: ответ до капа — ok, navigated (куда), uncertain; клик ровно один`, async (t) => {
      if (!ext) return t.skip("нет Chrome с Extensions.loadUnpacked");
      const { reply, ms, tab } = await act("click", { selector: sel });
      assert.ok(!reply.timeout, `tab.act не ответил за ${CAP} мс — завис на замороженной странице (мост ответил бы isError через 20 с)`);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.match(String(reply.data.navigated), /^http:\/\/127\.0\.0\.1:\d+\/(home|do-login)/u, JSON.stringify(reply));
      assert.equal(reply.data.uncertain, true, "уход страницы — исход клика НЕ подтверждён (verify-долг не снимается)");
      assert.ok(ms < CAP, `ms=${ms}`);
      assert.match(tab.url, /\/home$/u);
      if (path) assert.equal(posts.get(path), 1, "форма отправлена ровно один раз");
    });
  }

  it("контроль: клик без перехода — прежний ответ (changed, без navigated), вкладка на месте", async (t) => {
    if (!ext) return t.skip("нет Chrome с Extensions.loadUnpacked");
    const { reply, tab } = await act("click", { selector: "#noop" });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.data.changed, true);
    assert.equal(reply.data.navigated, undefined);
    assert.equal(reply.data.uncertain, undefined);
    assert.match(tab.url, /\/login$/u);
  });

  it("медленный POST (ответ сайта 2,5 с): не «не отреагировала», а переход вероятен — uncertain, форма ровно одна", async (t) => {
    if (!ext) return t.skip("нет Chrome с Extensions.loadUnpacked");
    const { reply, ms } = await act("click", { selector: "#slow" });
    assert.ok(!reply.timeout, `tab.act не ответил за ${CAP} мс`);
    assert.deepEqual([reply.ok, reply.data?.uncertain, reply.data?.changed], [true, true, undefined], JSON.stringify(reply));
    assert.match(String(reply.data.navigated), /\/(do-slow|home)$/u, JSON.stringify(reply));
    assert.ok(ms < CAP, `ms=${ms}`);
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(posts.get("/do-slow"), 1, "форма отправлена ровно один раз");
  });

  it("синтетический pagehide от самой страницы — не уход (isTrusted): ответ по факту клика, без navigated", async (t) => {
    if (!ext) return t.skip("нет Chrome с Extensions.loadUnpacked");
    const { reply, tab } = await act("click", { selector: "#fake" });
    assert.deepEqual([reply.ok, reply.data?.changed, reply.data?.navigated, reply.data?.uncertain], [true, true, undefined, undefined], JSON.stringify(reply));
    assert.match(tab.url, /\/login$/u);
  });
  it("§14: опасная подпись без одобрения — commit_confirm ДО клика (формы нет на сервере), с одобрением — ровно один клик", async (t) => {
    if (!ext) return t.skip("нет Chrome с Extensions.loadUnpacked");
    const no = await act("click", { selector: "#send", guard: GUARD });
    assert.deepEqual([no.reply.ok, no.reply.code, no.reply.label], [false, "commit_confirm", "Отправить"], JSON.stringify(no.reply));
    assert.equal(posts.get("/do-send"), undefined, "без одобрения форма не уходила");
    assert.match(no.tab.url, /\/login$/u);
    const yes = await act("click", { selector: "#send", guard: GUARD, guardApproved: true, approvedLabel: "Отправить" });
    assert.ok(!yes.reply.timeout, `одобренный клик не ответил за ${CAP} мс`);
    assert.deepEqual([yes.reply.ok, yes.reply.data?.uncertain], [true, true], JSON.stringify(yes.reply));
    assert.equal(posts.get("/do-send"), 1, "одобренная отправка — ровно одна");
  });
});
