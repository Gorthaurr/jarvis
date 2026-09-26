// Сценарий: зрение во вкладке — browser_read{view:"image"} отдаёт НАСТОЯЩИЙ снимок видимой области (PNG/JPEG,
// не пустышку), зум по ref — кроп элемента (меньше полного кадра). Файлы кладём в <стенд>/out для глаз агента.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { saveImages } from "../client.mjs";
import { begin, newRun, open, sleep, tool } from "../lib.mjs";
import { waitsFix } from "./defects.mjs";

let release;
before(async () => {
  release = await begin();
  await open(`https://shop.example.com/?run=${newRun("img")}`);
});
after(() => release?.());

const PNG = "iVBORw0KGgo";
const JPEG = "/9j/";

function image(r) {
  const img = r.result.content.find((c) => c.type === "image");
  assert.ok(img, `картинки нет: ${r.result.text.slice(0, 300)}`);
  assert.ok(img.data.startsWith(PNG) || img.data.startsWith(JPEG), `не PNG/JPEG: ${img.data.slice(0, 16)}`);
  return img;
}

test("browser_read{view:image}: снимок вкладки приходит и он настоящий (> 5 КБ)", { timeout: 120_000 }, async () => {
  const r = await tool("browser_read", { view: "image" });
  assert.equal(r.result.isError, false, r.result.text);
  const img = image(r);
  assert.ok(img.bytes > 5_000, `снимок подозрительно мал: ${img.bytes} байт`);
  saveImages(r.result, "image-full");
});

test("browser_read{view:image, ref}: зум на элемент — кроп меньше полного кадра", { timeout: 120_000 }, async () => {
  const full = image(await tool("browser_read", { view: "image" }));
  await tool("browser_inspect", { url: "shop.example.com" });
  await sleep(1_100); // квота Chrome на снимки (см. следующий тест)
  const r = await tool("browser_read", { view: "image", ref: "$ref:Добавить в корзину" });
  assert.equal(r.result.isError, false, r.result.text);
  const zoom = image(r);
  assert.ok(zoom.bytes > 500, `кроп пустой: ${zoom.bytes}`);
  assert.ok(zoom.bytes < full.bytes, `кроп (${zoom.bytes}) не меньше полного кадра (${full.bytes})`);
  saveImages(r.result, "image-zoom");
});

test("два снимка подряд (полный → зум) — оба приходят", waitsFix("CAPTURE_QUOTA"), async () => {
  await tool("browser_inspect", { url: "shop.example.com" });
  image(await tool("browser_read", { view: "image" }));
  const r = await tool("browser_read", { view: "image", ref: "$ref:Оформить заказ" });
  assert.equal(r.result.isError, false, r.result.text);
  image(r);
});
