/**
 * A/B по МОДЕЛЯМ/ЭКСПРЕССИИ для одного голоса (Daniel) — найти максимально ЖИВУЮ интонацию.
 * Сравниваем multilingual_v2 (текущая) vs eleven_v3 (эмоциональная) на одной фразе.
 * eleven_v3: stability ниже = «креативнее»/эмоциональнее; поддерживает audio-теги в тексте.
 * Ключ из .env, НЕ печатается. Запуск: node apps/server/tts-models-ab.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(resolve(here, "../../.env"), "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const apiKey = env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("Нет ELEVENLABS_API_KEY в .env");
  process.exit(1);
}

const DANIEL = "onwK4e9ZLuTAKqWW03F9";
const plain =
  "Добрый день, сэр. Джарвис к вашим услугам. Открыл ютуб — всё готово. " +
  "Встреча назначена на восемь двадцать, бюджет — полторы тысячи рублей.";
// Те же слова, но с подсказками интонации для v3 (audio-теги + эмфаза капсом).
const tagged =
  "[warmly] Добрый день, сэр. Джарвис к вашим услугам. " +
  "[thoughtfully] Открыл ютуб — всё готово. " +
  "Встреча назначена на восемь двадцать, бюджет — полторы тысячи рублей.";

// variant -> {model, settings, text}
const variants = {
  "v2-current": {
    model: "eleven_multilingual_v2",
    settings: { stability: 0.4, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true, speed: 0.95 },
    text: plain,
  },
  "v2-expressive": {
    model: "eleven_multilingual_v2",
    settings: { stability: 0.3, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true, speed: 0.97 },
    text: plain,
  },
  "v3-natural": {
    model: "eleven_v3",
    settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true },
    text: plain,
  },
  "v3-creative": {
    model: "eleven_v3",
    settings: { stability: 0.3, similarity_boost: 0.8, use_speaker_boost: true },
    text: plain,
  },
  "v3-creative-tags": {
    model: "eleven_v3",
    settings: { stability: 0.3, similarity_boost: 0.8, use_speaker_boost: true },
    text: tagged,
  },
};

console.log("Голос Daniel, сравнение моделей/экспрессии (ключ скрыт):");
for (const [name, v] of Object.entries(variants)) {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(DANIEL)}?output_format=mp3_44100_128`;
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text: v.text,
        model_id: v.model,
        voice_settings: v.settings,
        apply_text_normalization: "off",
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.log(`❌ ${name} [${v.model}]: HTTP ${resp.status} ${detail.slice(0, 220)}`);
      continue;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const out = resolve(here, `../../tts-model-${name}.mp3`);
    writeFileSync(out, buf);
    console.log(`✅ ${name} [${v.model}]: ${(buf.length / 1024).toFixed(1)} КБ за ${Date.now() - t0} мс → ${out}`);
  } catch (e) {
    console.log(`❌ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
