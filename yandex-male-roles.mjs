/** Сэмплы РАБОЧИХ ролей мужских голосов Yandex на слух (по итогам зонда). */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(here, ".env"), "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const apiKey = env.YANDEX_API_KEY, folderId = env.YANDEX_FOLDER_ID;
const URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";
const text = "Антон, ваше напоминание сработало. Пора идти.";
const outDir = resolve(here, "tts-emotion-samples");
mkdirSync(outDir, { recursive: true });

const cases = [
  ["filipp", "neutral"], ["filipp", "strict"],
  ["ermil", "neutral"], ["ermil", "good"],
  ["zahar", "neutral"], ["zahar", "good"],
  ["madirus", "whisper"],
];
for (const [voice, emotion] of cases) {
  const body = new URLSearchParams({ text, lang: "ru-RU", voice, emotion, format: "mp3", speed: "1.0" });
  if (folderId) body.set("folderId", folderId);
  const resp = await fetch(URL, { method: "POST", headers: { Authorization: `Api-Key ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!resp.ok) { console.log(`❌ ${voice}/${emotion}: ${resp.status}`); continue; }
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(resolve(outDir, `${voice}-${emotion}.mp3`), buf);
  console.log(`✅ ${voice}-${emotion}.mp3 (${(buf.length / 1024).toFixed(1)} КБ)`);
}
