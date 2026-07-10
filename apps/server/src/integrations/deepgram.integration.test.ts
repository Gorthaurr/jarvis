/**
 * РЕАЛЬНАЯ интеграция STT (НЕ моки): синтез речи (Yandex TTS) → PCM (ffmpeg) → настоящий Deepgram →
 * проверка реального транскрипта + КРОСС-ХОД ИЗОЛЯЦИИ. Гейт: RUN_LIVE_STT=1 (тратит TTS/Deepgram-баланс,
 * нужен ffmpeg). Запуск: RUN_LIVE_STT=1 npx vitest run deepgram.integration
 *
 * Этот тест ПОЙМАЛ реальный баг: persistent WS (JARVIS_DEEPGRAM_PERSISTENT=1) протекал — хвост turn1
 * всплывал в turn2 (общий таймлайн Deepgram). Per-utterance изолирован. Тест — гейт для будущего
 * фикса persistent: включишь флаг → тест на изоляцию должен ОСТАТЬСЯ зелёным.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DeepgramSttProvider } from "./deepgram.js";
import type { SttOpts, SttPartial } from "./voice-providers.js";
import { YandexTtsProvider } from "./yandex-tts.js";

const LIVE = process.env.RUN_LIVE_STT === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPTS: SttOpts = { sampleRate: 16000, language: "ru", interimResults: true } as SttOpts;

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(process.cwd(), "..", "..", ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
    }
  } catch {
    /* нет .env — тест и так пропустится без ключей */
  }
}

async function synth(text: string): Promise<ArrayBuffer> {
  const tts = new YandexTtsProvider({ apiKey: process.env.YANDEX_API_KEY, folderId: process.env.YANDEX_FOLDER_ID, voiceId: process.env.YANDEX_VOICE });
  return new Promise((res, rej) => {
    const s = tts.synthesize(text);
    let buf: ArrayBuffer | null = null;
    s.onChunk((c) => (buf = c.audio));
    s.onError(rej);
    s.onDone(() => (buf ? res(buf) : rej(new Error("TTS не дал аудио"))));
  });
}
function mp3ToPcm(mp3: ArrayBuffer): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "dgit-"));
  const inF = join(dir, "a.mp3");
  const outF = join(dir, "a.pcm");
  writeFileSync(inF, Buffer.from(mp3));
  const r = spawnSync("ffmpeg", ["-y", "-i", inF, "-ar", "16000", "-ac", "1", "-f", "s16le", outF], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffmpeg: " + String(r.stderr).slice(-160));
  return readFileSync(outF);
}
async function transcribe(stt: DeepgramSttProvider, pcm: Buffer): Promise<string> {
  const stream = stt.open(OPTS);
  let final = "";
  stream.onPartial((p: SttPartial) => { if (p.final) final = p.text; });
  const FRAME = 3200; // 100мс @16к s16le
  for (let o = 0; o < pcm.length; o += FRAME) {
    stream.pushAudio(new Uint8Array(pcm.subarray(o, o + FRAME)).buffer);
    await sleep(35);
  }
  await sleep(500);
  await stream.close();
  await sleep(150);
  return final.toLowerCase();
}

describe.skipIf(!LIVE)("Deepgram STT РЕАЛЬНО (TTS→ffmpeg→Deepgram)", () => {
  let pcmA: Buffer; // "Привет Джарвис как дела"
  let pcmB: Buffer; // "Сегодня хорошая погода"

  beforeAll(async () => {
    loadEnv();
    if (!process.env.DEEPGRAM_API_KEY || !process.env.YANDEX_API_KEY) throw new Error("нужны DEEPGRAM_API_KEY и YANDEX_API_KEY");
    pcmA = mp3ToPcm(await synth("Привет Джарвис, как дела."));
    pcmB = mp3ToPcm(await synth("Сегодня хорошая погода."));
  }, 30_000);

  it("реальная речь → непустой транскрипт с ожидаемым словом", async () => {
    const stt = new DeepgramSttProvider(process.env.DEEPGRAM_API_KEY);
    const t = await transcribe(stt, pcmA);
    stt.dispose();
    expect(t.length).toBeGreaterThan(0);
    expect(t).toContain("привет"); // ключевое слово реально распознано
  }, 30_000);

  it("КРОСС-ХОД ИЗОЛЯЦИЯ: turn2 (другая фраза) НЕ содержит слов turn1 (без утечки)", async () => {
    const stt = new DeepgramSttProvider(process.env.DEEPGRAM_API_KEY);
    const t1 = await transcribe(stt, pcmA); // "Привет Джарвис..."
    const t2 = await transcribe(stt, pcmB); // "Сегодня хорошая погода"
    stt.dispose();
    expect(t1).toContain("привет");
    expect(t2).toContain("погод"); // turn2 распознан ПОЛНОСТЬЮ, включая ПОСЛЕДНЕЕ слово (проверка фикса tail-loss)
    expect(t2).not.toContain("привет"); // ГЛАВНОЕ: НЕ протёк хвост turn1 (баг persistent WS, ловится этим тестом)
    expect(t2).not.toContain("джерв"); // и имя из turn1 не протекло
  }, 40_000);
});
