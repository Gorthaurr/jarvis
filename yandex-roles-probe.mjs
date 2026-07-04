/**
 * Зонд РОЛЕЙ/ЭМОЦИЙ Yandex по голосам (v1). Цель — выяснить, какие голоса (особенно мужские:
 * filipp/ermil/zahar/madirus) реально МЕНЯЮТ звук от роли, а какие принимают параметр и игнорируют.
 * Логика: на каждый голос синтезируем набор ролей; сравниваем sha. Невалидную роль ('zzz_invalid')
 * шлём специально — если движок её отвергает с 400, значит роли он ВАЛИДИРУЕТ (т.е. поддерживает),
 * а текст ошибки Yandex часто перечисляет валидный набор. Если же невалидную принимает с 200 и тем же
 * sha, что у neutral — голос роли ИГНОРИРУЕТ полностью. Ключ из .env, не печатается.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(here, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const apiKey = env.YANDEX_API_KEY;
const folderId = env.YANDEX_FOLDER_ID;

const SYNTH_URL = "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";
const text = "Антон, ваше напоминание сработало. Пора идти.";
const voices = ["filipp", "ermil", "zahar", "madirus", "jane", "omazh"];
const roles = ["neutral", "good", "evil", "strict", "friendly", "whisper", "zzz_invalid"];

async function synth(voice, emotion) {
  const body = new URLSearchParams({ text, lang: "ru-RU", voice, emotion, format: "mp3", speed: "1.0" });
  if (folderId) body.set("folderId", folderId);
  const resp = await fetch(SYNTH_URL, {
    method: "POST",
    headers: { Authorization: `Api-Key ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) return { err: `${resp.status} ${(await resp.text().catch(() => "")).slice(0, 220)}` };
  const buf = Buffer.from(await resp.arrayBuffer());
  return { sha: createHash("sha256").update(buf).digest("hex").slice(0, 10) };
}

for (const voice of voices) {
  console.log(`\n=== ${voice} ===`);
  const shas = {};
  for (const role of roles) {
    const r = await synth(voice, role);
    if (r.err) console.log(`  ${role.padEnd(12)} ❌ ${r.err}`);
    else { shas[role] = r.sha; console.log(`  ${role.padEnd(12)} ✅ sha=${r.sha}`); }
  }
  const ok = Object.entries(shas).filter(([k]) => k !== "zzz_invalid");
  const uniq = new Set(ok.map(([, v]) => v));
  const ignoresInvalid = shas.zzz_invalid && shas.neutral && shas.zzz_invalid === shas.neutral;
  let verdict;
  if (uniq.size <= 1) verdict = "роли НЕ влияют (все валидные одинаковы) → эмоция игнорируется";
  else verdict = `роли ВЛИЯЮТ (${uniq.size} разных звуков)`;
  if (ignoresInvalid) verdict += " · невалидную роль принимает молча (нет валидации)";
  console.log(`  → ${verdict}`);
}
