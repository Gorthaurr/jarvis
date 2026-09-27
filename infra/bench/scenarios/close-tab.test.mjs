// Сценарий: вкладку закрыли ПОСРЕДИ работы инструмента (страница грузится 10 с, browser_inspect ждёт загрузки) →
// честная ошибка «вкладка закрылась», никакого «сделано»; сервер фикстур страницу так и не отдал. Плюс гонка
// «inspect{url} сразу после open» (сторож фикса W1-D3).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { begin, cdp, newRun, sleep, tool, traces, waitFacts } from "../lib.mjs";
import { resetTabs } from "../chrome.mjs";
import { waitsFix } from "./defects.mjs";

let release;
before(async () => {
  release = await begin();
});
after(() => release?.());

test("закрытие вкладки посреди browser_inspect → честная ошибка, страница не отдана", { timeout: 120_000 }, async () => {
  const run = newRun("close");
  await resetTabs();
  const opened = await tool("browser_open", { url: `https://news.example.com/slow?ms=10000&run=${run}` });
  assert.equal(opened.result.isError, false, opened.result.text);
  // Без url: цель — вкладка из browser_open (tabId) — ждёт загрузки её.
  const pending = tool("browser_inspect", {});
  // Пока навигация не закоммичена, CDP показывает вкладку как about:blank/старый адрес — узнаём её исключением:
  // заводим свою пустую вкладку (чтобы браузер не закрылся вместе с последней) и закрываем все остальные.
  await sleep(1_000); // inspect уже ждёт загрузку (сервер держит страницу 10 с)
  const keep = await cdp.newTab("about:blank");
  const victims = (await cdp.pages()).filter((t) => t.id !== keep.id);
  assert.ok(victims.length >= 1, "нечего закрывать — вкладка медленной страницы не открылась");
  for (const t of victims) await cdp.close(t.id);
  const r = await pending;
  assert.equal(r.result.isError, true, `ожидали честную ошибку, пришло: ${r.result.text}`);
  assert.match(r.result.text, /закрыл|закрыт|closed|gone/i);
  assert.notEqual(r.result.flags.sent, true);
  assert.notEqual(r.result.flags.observed, true, "закрытая вкладка — не сверка");
  await sleep(1_500);
  assert.equal((await traces(run, "slow_served")).length, 0, "страница не должна была отдаться");
  assert.equal((await waitFacts(run, "feed_more", 1, 300)).length, 0);
});

test("browser_inspect{url} сразу после browser_open медленной страницы → находит вкладку", waitsFix("OPEN_RACE"), async () => {
  const run = newRun("race");
  await resetTabs();
  await tool("browser_open", { url: `https://news.example.com/slow?ms=1500&run=${run}` });
  const r = await tool("browser_inspect", { url: "news.example.com" });
  assert.equal(r.result.isError, false, r.result.text);
});
