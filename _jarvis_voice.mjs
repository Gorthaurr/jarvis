// Голосовой драйвер Джарвиса — боевой прогон ГОЛОСОВОГО пути без микрофона (2026-09-24).
//
// Фраза синтезируется Yandex SpeechKit в сырой PCM 16 кГц (голос «владельца» — не голос Джарвиса), режется на кадры
// по 20 мс и идёт в сервер ровно как от клиента: audio.vad wake_local → speech_start → audio.frame в реальном темпе →
// хвост тишины → speech_end. Дальше всё настоящее: облачный STT, wake-гейт, эндпоинтинг, мозг, TTS-ответ. Драйвер
// печатает, что сервер РАСПОЗНАЛ, что ответил, и задержки (конец речи → первый ответ).
//
// Сессия драйвера — dev («cmd-test»): своя рабочая память, задачи не в истории владельца. Действия на ПК драйвер
// НЕ исполняет (честный отказ, как у текст-драйвера): руки проверяются через окно живого клиента.
//
// Запуск: node _jarvis_voice.mjs "Джарвис, какая погода завтра в Москве" "а послезавтра?"
// Env: JARVIS_WS_URL (деф ws://127.0.0.1:8787/ws), JARVIS_VOICE_SPEAKER (деф zahar), JARVIS_VOICE_NO_WAKE=1 — не слать
// wake_local (проверить текстовый wake «Джарвис» из STT), JARVIS_VOICE_GAP_MS — пауза между фразами (деф 12000).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WS_URL = process.env.JARVIS_WS_URL || "ws://127.0.0.1:8787/ws";
const SPEAKER = process.env.JARVIS_VOICE_SPEAKER || "zahar";
const GAP_MS = Number(process.env.JARVIS_VOICE_GAP_MS || 12000);
const TIMEOUT_MS = Number(process.env.JARVIS_VOICE_TIMEOUT_MS || 150000);
const SR = 16000;
const FRAME = 320; // 20 мс

function envVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = new RegExp(`^${name}=(.*)$`, "mu").exec(readFileSync(join(here, ".env"), "utf8"));
    return m?.[1]?.trim().replace(/^["']|["']$/gu, "") || "";
  } catch {
    return "";
  }
}

async function synth(text) {
  const apiKey = envVar("YANDEX_API_KEY");
  if (!apiKey) throw new Error("нет YANDEX_API_KEY — синтезировать фразу нечем");
  const body = new URLSearchParams({ text, lang: "ru-RU", voice: SPEAKER, format: "lpcm", sampleRateHertz: String(SR) });
  const folder = envVar("YANDEX_FOLDER_ID");
  if (folder) body.set("folderId", folder);
  const r = await fetch("https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize", {
    method: "POST",
    headers: { Authorization: `Api-Key ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`TTS HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return new Int16Array(await r.arrayBuffer());
}

const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}с`, ...a);
const ws = new WebSocket(WS_URL);
const send = (type, payload) => ws.send(JSON.stringify({ id: globalThis.crypto.randomUUID(), ts: Date.now(), type, payload }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let speechEndAt = 0;
let firstReplyLogged = false;
let seq = 0;

async function say(text, pcm) {
  firstReplyLogged = false;
  log(`🎤 говорю: «${text}» (${(pcm.length / SR).toFixed(1)} с)`);
  if (process.env.JARVIS_VOICE_NO_WAKE !== "1") send("audio.vad", { state: "wake_local" });
  send("audio.vad", { state: "speech_start" });
  const silence = new Int16Array(FRAME);
  const frames = [];
  for (let i = 0; i < pcm.length; i += FRAME) frames.push(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
  for (let i = 0; i < 40; i++) frames.push(silence); // 0,8 с хвоста тишины — как у живой речи
  const start = Date.now();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i].length === FRAME ? frames[i] : Int16Array.from({ length: FRAME }, (_, k) => frames[i][k] ?? 0);
    send("audio.frame", { pcm: Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64"), sampleRate: SR, seq: seq++ });
    const due = start + (i + 1) * 20;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
  }
  send("audio.vad", { state: "speech_end" });
  speechEndAt = Date.now();
}

const phrases = process.argv.slice(2);
ws.onopen = () => send("client.hello", { token: process.env.JARVIS_CLIENT_TOKEN || "dev", clientVersion: "cmd-test", protocolVersion: 1 });
ws.onerror = (e) => log("WS error", e.message || e);
ws.onclose = () => log("WS closed");
ws.onmessage = async (ev) => {
  let env;
  try {
    env = JSON.parse(ev.data);
  } catch {
    return;
  }
  const p = env.payload || {};
  const sinceEnd = () => (speechEndAt ? `+${((Date.now() - speechEndAt) / 1000).toFixed(2)}с после конца речи` : "");
  switch (env.type) {
    case "server.hello": {
      log("server.hello session=", p.sessionId);
      const pcms = [];
      for (const t of phrases) pcms.push(await synth(t));
      for (let i = 0; i < phrases.length; i++) {
        await say(phrases[i], pcms[i]);
        if (i < phrases.length - 1) await sleep(GAP_MS);
      }
      setTimeout(() => {
        log("--- конец прогона ---");
        ws.close();
        process.exit(0);
      }, GAP_MS);
      break;
    }
    case "ping":
      send("pong", {});
      break;
    case "transcript":
      if (p.final) log(`📝 transcript${p.role ? `[${p.role}]` : ""}: «${p.text}»`, sinceEnd());
      break;
    case "chat":
      log(`💬 ${p.role}: ${p.text}`, p.role === "assistant" ? sinceEnd() : "");
      break;
    case "speak.chunk":
      if (!firstReplyLogged) {
        firstReplyLogged = true;
        log(`🔊 первый звук ответа ${sinceEnd()}`);
      }
      break;
    case "client.state":
      log(`state → ${p.state}`);
      break;
    case "user.confirm.request":
      log("CONFIRM-REQ:", p.summary, "→ отказ (драйвер не подтверждает необратимое)");
      send("user.confirm.result", { requestId: p.requestId, approved: false });
      break;
    case "action.command":
      log("ACTION→client:", p.kind, "(драйвер не исполняет — честный отказ)");
      send("action.result", { commandId: env.id, ok: false, error: { code: "runtime", message: "голосовой драйвер не исполняет действия на ПК" }, durationMs: 1 });
      break;
    default:
      break;
  }
};
setTimeout(() => {
  log("--- timeout ---");
  process.exit(1);
}, TIMEOUT_MS);
