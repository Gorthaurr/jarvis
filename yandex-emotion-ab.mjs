/**
 * A/B-проверка ЭМОЦИИ Yandex SpeechKit v1: один и тот же текст × голос × emotion.
 * Цель — выяснить, ПРИМЕНЯЕТСЯ ли параметр emotion (good/evil/neutral) к голосу filipp
 * (по докам — только jane/omazh поддерживают эмоцию). Сравниваем размер mp3 и пишем файлы
 * на слух. Если у голоса good==evil==neutral по байтам — эмоция движком игнорируется.
 * Ключ из .env, НЕ печатается. Запуск:  node yandex-emotion-ab.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const apiKey = env.YANDEX_API_KEY;
const folderId = env.YANDEX_FOLDER_ID;
if (!apiKey) {
  console.error("Нет YANDEX_API_KEY в .env");
  process.exit(1);
}

const SYNTH_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";
// Нейтральный текст — чтобы единственной переменной была эмоция движка (а не слова).
const text = "Антон, ваше напоминание сработало. Пора идти.";

// Голос → набор эмоций для проверки. filipp — текущий в проекте; jane/omazh — по докам эмоциональные.
const cases = [
  ["filipp", "neutral"],
  ["filipp", "good"],
  ["filipp", "evil"],
  ["jane", "neutral"],
  ["jane", "good"],
  ["jane", "evil"],
  ["omazh", "good"],
  ["omazh", "evil"],
];

const outDir = resolve(here, "tts-emotion-samples");
mkdirSync(outDir, { recursive: true });

console.log(`Yandex v1 emotion A/B · текст «${text}» (${text.length} симв.) · ключ скрыт\n`);
const results = [];
for (const [voice, emotion] of cases) {
  const body = new URLSearchParams({ text, lang: "ru-RU", voice, emotion, format: "mp3", speed: "1.0" });
  if (folderId) body.set("folderId", folderId);
  const t0 = Date.now();
  try {
    const resp = await fetch(SYNTH_URL, {
      method: "POST",
      headers: { Authorization: `Api-Key ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.log(`❌ ${voice}/${emotion}: HTTP ${resp.status} ${detail.slice(0, 200)}`);
      results.push({ voice, emotion, error: `HTTP ${resp.status}` });
      continue;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const sha = createHash("sha256").update(buf).digest("hex").slice(0, 12);
    const out = resolve(outDir, `${voice}-${emotion}.mp3`);
    writeFileSync(out, buf);
    console.log(`✅ ${voice}/${emotion}: ${(buf.length / 1024).toFixed(1)} КБ · sha=${sha} · ${Date.now() - t0} мс`);
    results.push({ voice, emotion, bytes: buf.length, sha });
  } catch (e) {
    console.log(`❌ ${voice}/${emotion}: ${e instanceof Error ? e.message : String(e)}`);
    results.push({ voice, emotion, error: String(e) });
  }
}

// Вывод: для каждого голоса — отличаются ли good/evil/neutral по хэшу (= применяется ли эмоция).
console.log("\n── Анализ: применяется ли эмоция (разные sha = разный звук) ──");
for (const voice of ["filipp", "jane", "omazh"]) {
  const rows = results.filter((r) => r.voice === voice && r.sha);
  if (rows.length < 2) continue;
  const uniq = new Set(rows.map((r) => r.sha));
  const verdict = uniq.size === 1
    ? "❌ ЭМОЦИЯ ИГНОРИРУЕТСЯ (все варианты идентичны по байтам)"
    : `✅ эмоция влияет (${uniq.size} различных звуков из ${rows.length})`;
  console.log(`${voice}: ${verdict} — ${rows.map((r) => `${r.emotion}=${r.sha}`).join(", ")}`);
}
console.log(`\nФайлы: ${outDir}`);
