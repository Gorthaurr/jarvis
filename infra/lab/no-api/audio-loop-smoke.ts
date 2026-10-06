/** Реальный KWS/VAD → WS → Whisper → команда → Windows TTS. Актуатор и плеер виртуальные. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startLabServer } from "../lib/server.js";
import { connectLabClient } from "../lib/client.js";
import { createFakeDesktop } from "../desktop/index.js";
import { createAudioStand } from "../audio/stand.js";
import { loadHearing } from "../audio/hearing-rig.js";

const hearing = await loadHearing();
if (!hearing.ok) throw new Error(hearing.reason);
const server = await startLabServer({ brain: "off", stt: "mock", keepDir: true, env: {
  STT_PROVIDER: "whisper", WHISPER_MODEL: "Xenova/whisper-base", HF_ENDPOINT: "https://huggingface.co",
  WHISPER_DEVICE: "cpu", WHISPER_DTYPE: "q8", TTS_PROVIDER: "windows", JARVIS_SPEAKER_GATE: "0",
  LLM_PROVIDER: "codex", CODEX_MODEL: "gpt-6-luna",
  OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", YANDEX_API_KEY: "", ELEVENLABS_API_KEY: "", DEEPGRAM_API_KEY: "",
} });
console.log(JSON.stringify({ stage: "server", port: server.port, log: server.outLog }));
const client = await connectLabClient({ server, desktop: createFakeDesktop(), keepAudio: true });
const stand = await createAudioStand({ client, hearing, realtime: true, engageGraceMs: 15_000 });
try {
  const result = await stand.sayWav(resolve("apps/client/test-audio/pos_filipp_1.wav"), { timeoutMs: 90_000 });
  const events = client.events().filter((e) => e.type !== "audio.frame");
  const path = resolve("docs/lab/runs", `no-api-audio-loop-${Date.now()}.json`);
  await mkdir(resolve("docs/lab/runs"), { recursive: true });
  await writeFile(path, JSON.stringify({ result, events, serverLog: server.logTail(150) }, null, 2));
  console.log(JSON.stringify({ transcript: result.transcript, wake: result.hearing.wakeFired,
    states: result.states, actions: result.actions, speech: result.speech, report: path }));
  if (!result.hearing.wakeFired || !/блокнот/i.test(result.transcript) || !result.actions.some((a) => a.cmd.kind === "app.launch" && a.result.ok)
    || result.speech.chunks === 0 || result.ended === "timeout") throw new Error("Local voice loop failed; see report");
} finally { await stand.close(); await client.close(); await server.stop({ keepDir: true }); }
