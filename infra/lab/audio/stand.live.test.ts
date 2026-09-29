/**
 * ЖИВОЙ прогон стенда: настоящий изолированный лаб-сервер (свой порт, PGlite, brain off) + WS-клиент + настоящий слух.
 * STT сервера — настоящий Deepgram (ключ пробросом в env процесса сервера, в файлы/логи не попадает; стоимость — копейки на
 * 2 коротких WAV). Пропуск — только с причиной: нет моделей слуха / нет ключа / LAB_SKIP_LIVE=1. Боевой сервер (8787) не трогается.
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeDesktop } from "../desktop/index.js";
import { connectLabClient, type LabClientHandle } from "../lib/client.js";
import { repoRoot } from "../lib/deps.js";
import { readOwnerVar } from "../lib/server-env.js";
import { type LabServerHandle, startLabServer } from "../lib/server.js";
import { audioStandAvailability, CORPUS_DIR } from "./availability.js";
import { loadHearing } from "./hearing-rig.js";
import { type AudioStandEx, createAudioStand } from "./stand.js";

const avail = audioStandAvailability();
const hasKey = Boolean(readOwnerVar("DEEPGRAM_API_KEY")); // только факт наличия, значение нигде не хранится и не печатается
const reason = !avail.ok ? avail.reason : process.env.LAB_SKIP_LIVE === "1" ? "LAB_SKIP_LIVE=1" : !hasKey ? "нет DEEPGRAM_API_KEY (окружение или .env владельца)" : !existsSync(repoRoot("infra/lab/lib/server.ts")) ? "нет infra/lab/lib/server.ts" : "";
if (reason) console.warn(`[audio-stand live] SKIP: ${reason}`);

describe.skipIf(reason !== "")("аудио-стенд ЖИВОЙ: слух → лаб-сервер (Deepgram) → озвучка", () => {
  let server: LabServerHandle;
  let client: LabClientHandle;
  let stand: AudioStandEx;

  beforeAll(async () => {
    const hearing = await loadHearing();
    if (!hearing.ok) throw new Error(hearing.reason);
    server = await startLabServer({ stt: "deepgram", brain: "off" });
    client = await connectLabClient({ server, desktop: createFakeDesktop(), keepAudio: true });
    stand = await createAudioStand({ client, hearing, realtime: true });
  }, 180_000);

  afterAll(async () => {
    await stand?.close();
    await client?.close();
    await server?.stop();
  }, 60_000);

  it("«Джарвис, …» голосом: KWS → wake_local → Deepgram распознал → сервер начал ход → озвучка сохранена", async () => {
    // Серверная гонка (README «Находки»): ход, чей interim пуст к speech_end, гибнет — кадры хвоста открывают новый STT-стрим
    // и abandonTurn() глушит запечатывание прежнего. Поэтому берём до 4 попыток и ПЕЧАТАЕМ долю потерь, а не прячем её.
    const outcomes: string[] = [];
    let r: Awaited<ReturnType<AudioStandEx["sayWav"]>> | undefined;
    let firstWake: boolean | undefined; // «Джарвис» слышит KWS только на первой попытке: дальше гейт держит follow-up-окно сервера
    for (let i = 0; i < 4 && !r?.transcript; i += 1) {
      await stand.waitIdle(30_000);
      r = await stand.sayWav(`${CORPUS_DIR}/pos_filipp_1.wav`, { timeoutMs: 90_000 });
      firstWake ??= r.hearing.wakeFired;
      outcomes.push(r.transcript ? `распознано «${r.transcript}»` : "ход потерян сервером");
    }
    console.log("[live] попытки:", outcomes.join(" | "));
    console.log("[live] hearing:", JSON.stringify(r?.stats), "states:", r?.states.join(">"), "answer:", JSON.stringify(r?.answer), "speech:", JSON.stringify(r?.speech), "files:", r?.speechFiles.length);
    if (!r?.transcript) dumpEvents(client, server);
    expect(firstWake).toBe(true);
    expect(r?.stats.framesSent).toBeGreaterThan(20);
    expect(r?.transcript.toLowerCase()).toContain("блокнот"); // содержание pos_filipp_1 — «…открой блокнот»
    expect(r?.states).toContain("thinking");
    expect(r?.ended).not.toBe("timeout");
    expect(r?.speech.chunks).toBeGreaterThan(0);
    expect(r?.speechFiles.length).toBeGreaterThan(0); // озвучка ушла в файл, а не пропала
    expect(r?.speechFiles[0]?.bytes).toBeGreaterThan(0);
    expect(r?.hearing.log.join(" | ")).not.toContain("ВНИМАНИЕ озвучка пришла без байтов");
  }, 400_000);

  it("чужая речь без «Джарвис» (neg_*) в живую: слух молчит, до Deepgram не доходит ни кадра", async () => {
    await stand.waitIdle(30_000);
    const r = await stand.sayWav(`${CORPUS_DIR}/neg_alena_1.wav`, { timeoutMs: 60_000 });
    expect(r.hearing.wakeFired).toBe(false);
    expect(r.stats.framesSent).toBe(0);
    expect(r.transcript).toBe("");
  }, 120_000);
});

/** Диагностика провала: лента событий сессии без кадров + строки лога сервера про голос/STT (payload режем). */
function dumpEvents(c: LabClientHandle, server: LabServerHandle): void {
  const rows = c.events().filter((e) => e.type !== "audio.frame").map((e) => `${e.dir} ${e.type} ${JSON.stringify(e.payload).slice(0, 200)}`);
  const logs = server.logTail(400).split(String.fromCharCode(10)).filter((l) => /voice:pipeline|stt:deepgram/.test(l)).map((l) => l.slice(0, 300));
  console.log(["[live] события:", ...rows, "[live] лог сервера:", ...logs].join(String.fromCharCode(10)));
}
