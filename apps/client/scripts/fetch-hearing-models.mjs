// W1: поставить модели слуха в ~/.jarvis/models (ASCII-путь — sherpa не читает кириллицу в пути).
//   node apps/client/scripts/fetch-hearing-models.mjs
// Идемпотентно: существующие файлы не перекачиваются. Нужен tar с bzip2 (Git for Windows даёт).
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = process.env.JARVIS_HEARING_MODELS || join(homedir(), ".jarvis", "models");
const KWS = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const KWS_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${KWS}.tar.bz2`;
const SILERO_URL = "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx";

/**
 * Ключевые слова — BPE-написания того, как английская KWS-модель «слышит» русское «Джарвис».
 * Формат строки: токены, `:boost`, `#threshold`, `@метка`. Подобрано пробой 2026-09-09 на TTS-голосах
 * (filipp/alena/zahar/jane/john): jadavice/jottovis/javas — реальные декоды «Джарвис». Добавляйте
 * написания, если в логе клиента wake не ловит ваш голос (`sherpa-onnx` ASR-декод покажет токены).
 */
const KEYWORDS = [
  "▁JA R VI S :2.0 #0.2 @jarvis",
  "▁HE Y ▁JA R VI S :2.0 #0.2 @hey_jarvis",
  "▁JA VI S :2.0 #0.2 @javis",
  "▁JA R VI CE :2.0 #0.2 @jarvice",
  "▁JA D A VI CE :2.0 #0.2 @jadavice",
  "▁JA V AS :2.0 #0.2 @javas",
  "▁JE R VI S :2.0 #0.2 @jervis",
  "▁ D J AR VI S :2.0 #0.2 @djarvis",
  "▁JO T T O VI S :2.0 #0.2 @jottovis",
];

async function download(url, to) {
  if (existsSync(to)) return console.log("есть:", to);
  console.log("качаю:", url);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  writeFileSync(to, Buffer.from(await r.arrayBuffer()));
  console.log("готово:", to);
}

if (!/^[\x00-\x7F]*$/.test(dir)) throw new Error(`каталог моделей должен быть ASCII-путём: ${dir}`);
mkdirSync(join(dir, "kws"), { recursive: true });
await download(SILERO_URL, join(dir, "silero_vad.onnx"));
if (!existsSync(join(dir, "kws", KWS, "tokens.txt"))) {
  const tar = join(dir, "kws", "kws.tar.bz2");
  await download(KWS_URL, tar);
  execFileSync("tar", ["xjf", tar], { cwd: join(dir, "kws"), stdio: "inherit" });
  rmSync(tar, { force: true });
}
const kw = join(dir, "kws", "jarvis-keywords.txt");
if (!existsSync(kw)) writeFileSync(kw, KEYWORDS.join("\n") + "\n", "utf8");
console.log("модели слуха готовы:", dir);
