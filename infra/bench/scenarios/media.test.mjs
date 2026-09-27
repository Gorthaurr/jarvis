// Сценарий: видео и лента (безопасные хосты). Политику autoplay стенд НЕ отключает: play из расширения может не
// дать звука/движения — тогда инструмент обязан сказать «не заиграло», а не «играет». Проверяем равносильность:
// «инструмент говорит — играет» ⇔ страница прислала факт media_play. Лента: «Показать ещё» — без вопроса, факт один.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { begin, newRun, open, sleep, tool, waitFacts } from "../lib.mjs";

let release;
before(async () => {
  release = await begin();
});
after(() => release?.());

test("play на видео: заявка инструмента совпадает с фактом страницы (autoplay-гейт честно)", { timeout: 120_000 }, async () => {
  const run = newRun("video");
  await open(`https://video.example.com/?run=${run}`);
  await tool("browser_inspect", { url: "video.example.com" });
  const r = await tool("browser_act", { intent: "play" });
  const played = (await waitFacts(run, "media_play", 1, 3_000)).length > 0;
  const claims = r.result.isError === false;
  assert.equal(claims, played, `инструмент: isError=${r.result.isError} «${r.result.text.slice(0, 200)}»; факт play: ${played}`);
  if (played) {
    await sleep(1_500);
    const p = await tool("browser_act", { intent: "pause" });
    assert.equal(p.result.isError, false, p.result.text);
    assert.equal((await waitFacts(run, "media_pause", 1)).length, 1);
  }
});

test("лента: «Показать ещё» — без вопроса, факт ровно один; текст ленты читается", { timeout: 120_000 }, async () => {
  const run = newRun("feed");
  await open(`https://news.example.com/?run=${run}`);
  await tool("browser_inspect", { url: "news.example.com" });
  const r = await tool("browser_act", { intent: "click", ref: "$ref:Показать ещё" });
  assert.equal(r.result.isError, false, r.result.text);
  assert.equal(r.questions.length, 0);
  assert.equal((await waitFacts(run, "feed_more", 1)).length, 1);
  await sleep(1_000);
  assert.equal((await waitFacts(run, "feed_more", 2, 300)).length, 1);
  const read = await tool("browser_read", { selectorIntent: "Архив" });
  assert.match(read.result.text, /Архив №/);
});
