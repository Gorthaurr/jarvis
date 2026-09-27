// Сценарий: зрение во вкладке — browser_read{view:"image"} отдаёт НАСТОЯЩИЙ снимок видимой области (PNG/JPEG,
// не пустышку), зум по ref — кроп элемента (меньше полного кадра). Файлы кладём в <стенд>/out для глаз агента.
// Что на снимке ИМЕННО страница лавки — сверяем OCR (tesseract), а не размером файла.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  const [file] = saveImages(r.result, "image-full");
  // OMP_THREAD_LIMIT=1: под нагрузкой (сервер+Chromium на 4 CPU) OpenMP tesseract крутится вхолостую — 0,25 с → 38 с.
  const env = { ...process.env, OMP_THREAD_LIMIT: "1" };
  const text = execFileSync("tesseract", [file, "-", "-l", "rus+eng"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env });
  assert.match(text, /Маргарит|корзин/i, `на снимке не страница лавки (OCR: ${text.slice(0, 200)})`);
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

// Квота Chrome captureVisibleTab — 2 снимка/с. Окно квоты сначала очищаем: иначе исход зависел бы от соседнего теста
// (прогон одного этого теста давал бы ложное «починено»). Три снимка подряд (полный → зум → зум) — как модель в одном
// раунде; каждый обязан прийти (расширение выжидает квоту, а не падает).
test("три снимка подряд (полный → зум → зум) — все приходят", waitsFix("CAPTURE_QUOTA"), async () => {
  await tool("browser_inspect", { url: "shop.example.com" });
  await sleep(1_100);
  const t0 = Date.now();
  for (const input of [{ view: "image" }, { view: "image", ref: "$ref:Добавить в корзину" }, { view: "image", ref: "$ref:Оформить заказ" }]) {
    const r = await tool("browser_read", input);
    assert.equal(r.result.isError, false, `${JSON.stringify(input)} через ${Date.now() - t0} мс: ${r.result.text}`);
    image(r);
  }
});
