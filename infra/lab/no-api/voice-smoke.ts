/** Реальный офлайн синтез → WAV и Whisper. Без микрофона/воспроизведения и платных провайдеров. */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { WindowsTtsProvider } from "../../../apps/server/src/integrations/windows-tts.js";
import { WhisperSttProvider } from "../../../apps/server/src/integrations/whisper-stt.js";

const text = "Открой блокнот и запиши тест локального голосового помощника.";
const started = Date.now();
const pcm = await new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  const stream = new WindowsTtsProvider().synthesize(text);
  stream.onChunk((c) => chunks.push(Buffer.from(c.audio)));
  stream.onError(reject); stream.onDone(() => resolve(Buffer.concat(chunks)));
});
const ttsMs = Date.now() - started;
const wav = Buffer.alloc(44); wav.write("RIFF"); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40);
const dir = resolve("docs/lab/runs"); await mkdir(dir, { recursive: true });
const path = resolve(dir, "no-api-voice.wav"); await writeFile(path, Buffer.concat([wav, pcm]));
console.log(JSON.stringify({ stage: "tts", ttsMs, bytes: pcm.length, path }));
process.env.HF_ENDPOINT ??= "https://huggingface.co";
const transcript = await new Promise<string>((resolve, reject) => {
  const stream = new WhisperSttProvider(process.env.WHISPER_MODEL || "Xenova/whisper-base").open({ sampleRate: 16_000, language: "ru" });
  let result = "";
  stream.onPartial((p) => { if (p.final) result = p.text; }); stream.onError(reject); stream.onClose(() => resolve(result));
  stream.pushAudio(Uint8Array.from(pcm).buffer); void stream.close().catch(reject);
});
console.log(JSON.stringify({ stage: "stt", transcript, ms: Date.now() - started - ttsMs }));
if (!/блокнот/i.test(transcript)) throw new Error("Распознавание контрольной фразы не прошло");
