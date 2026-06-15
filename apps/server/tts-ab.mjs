/**
 * Живой подбор ГОЛОСА ElevenLabs под Джарвиса: одна фраза × разные voiceId на модели
 * multilingual_v2 с финальными voice_settings → mp3-файлы для сравнения на слух.
 * Если voiceId нет в аккаунте (Voice Library требует добавления в My Voices) — API вернёт
 * ошибку, и скрипт это покажет. Ключ из .env, НЕ печатается. Запуск: node tts-ab.mjs
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

const text =
  "Добрый день, сэр. Джарвис к вашим услугам. Открыл YouTube — всё готово. " +
  "Встреча назначена на восемь двадцать, бюджет — полторы тысячи рублей.";

const model = "eleven_multilingual_v2";
const settings = { stability: 0.6, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true, speed: 0.95 };

// name -> voiceId. Текущий Daniel + русско-нативные кандидаты + британский George.
const voices = {
  "daniel-current-uk": "onwK4e9ZLuTAKqWW03F9",
  "alan-ru-native": "zWSsRd3J6WyZFl12aGMB",
  "ivan-ru-native": "1qd9R09Ljlx9V1Ok0t5S",
  "george-uk-warm": "JBFqnCBsd6RMkjVDRZzb",
};

console.log(`model=${model}, ${text.length} симв., voice_settings=${JSON.stringify(settings)} (ключ скрыт)`);
for (const [name, voiceId] of Object.entries(voices)) {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model, voice_settings: settings, apply_text_normalization: "off" }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.log(`❌ ${name} (${voiceId}): HTTP ${resp.status} ${detail.slice(0, 160)}`);
      continue;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const out = resolve(here, `../../tts-voice-${name}.mp3`);
    writeFileSync(out, buf);
    console.log(`✅ ${name}: ${(buf.length / 1024).toFixed(1)} КБ за ${Date.now() - t0} мс → ${out}`);
  } catch (e) {
    console.log(`❌ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
