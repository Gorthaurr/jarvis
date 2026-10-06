import { settleAudioTurn } from "./stand-settle.js";
import { type AudioStandEx, type AudioStandOptions, type AudioStandResultEx, AudioStandUnavailable } from "./stand-types.js";
export { AudioStandUnavailable,type AudioStandEx,type AudioStandOptions,type AudioStandResultEx } from "./stand-types.js";
/**
 * createAudioStand — «WAV → настоящий клиентский слух → сервер → озвучка». Слух (AudioCoordinator + sherpa) НАСТОЯЩИЙ;
 * сервер и транспорт — через LabClient (тот же WS-протокол, что у Electron); озвучку принимает фейковый плеер, который
 * подтверждает audio.playback/audio.played и сохраняет звук в файлы. Режимы: realtime (по умолчанию) — кадры в реальном
 * темпе, годится для серверных таймингов; fast — виртуальные часы клиента и кадры без пауз, ТОЛЬКО для слуха/мока
 * (таймеры сервера остаются реальными, пачка кадров быстрее реального времени искажает его эндпоинтинг).
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TurnResult } from "../lib/contracts.js";
import { sliceAfter } from "./event-cursor.js";
import { FakePlayer } from "./fake-player.js";
import { ServerFeedback } from "./feedback.js";
import { HearingRig, loadHearing } from "./hearing-rig.js";
import { micChain, toFrames } from "./mic-model.js";
import { type NoiseKind, makeNoise } from "./noise.js";
import { type Phrase, SpeechStore } from "./speech-store.js";
import { buildTurn, recognized } from "./turn-collect.js";
import { loadWav16k } from "./wav.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const b64 = (pcm: Int16Array): string => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

export async function createAudioStand(o: AudioStandOptions): Promise<AudioStandEx> {
  const loaded = o.hearing ?? (await loadHearing(o.hearingDir));
  if (!loaded.ok) throw new AudioStandUnavailable(loaded.reason);
  const { client } = o;
  const outDir = (o.outDir ?? join(tmpdir(), "jarvis-lab", "audio", String(Date.now()))).split("\\").join("/");
  mkdirSync(outDir, { recursive: true });
  const store = new SpeechStore(outDir);
  let turn = 0;
  let phrases: Phrase[] = [];
  let playerChangedAt = Date.now();

  const rig: HearingRig = new HearingRig(
    loaded.hearing,
    {
      frame: (pcm, seq) => client.send("audio.frame", { pcm: b64(pcm), sampleRate: 16_000, seq }),
      vad: (state) => client.send("audio.vad", { state }),
      rescue: (pcm, meta) => {
        try {
          client.send("audio.wake_rescue", { pcm: b64(pcm), sampleRate: 16_000, ms: meta.ms, peak: meta.peak });
          return true;
        } catch {
          return false;
        }
      },
      bargeIn: () => player.stop(),
    },
    loaded.tap,
  );
  const player: FakePlayer = new FakePlayer(
    {
      sendPlayback: (active) => {
        playerChangedAt = Date.now();
        client.send("audio.playback", { active });
      },
      sendPlayed: (gen, ts) => client.send("audio.played", { gen, ts, seq: 0 }),
      setCoordinatorActive: (a) => rig.ac.setPlaybackActive(a),
      onPhrase: (p) => {
        if (p.bytes > 0) phrases.push(store.save(turn, p)); // пустая «фраза» = аудио вырезано клиентом, файл-пустышка не нужен
      },
    },
    o.playbackRate ?? 1,
  );
  const fb = new ServerFeedback(client, rig.ac, player, rig.probe);
  const quietMs = o.quietMs ?? 1000;
  const grace = o.engageGraceMs ?? 8000;

  async function run(label: string, frames: Int16Array[], realtime: boolean, timeoutMs: number): Promise<AudioStandResultEx> {
    fb.drain();
    const mark = client.events().at(-1);
    rig.probe.begin();
    fb.beginTurn();
    turn += 1;
    phrases = [];
    const t0 = Date.now();
    const pump = setInterval(() => fb.drain(), 10);
    let ended: TurnResult["ended"];
    let feedMs: number;
    try {
      await rig.feed(frames, realtime);
      feedMs = Date.now() - t0;
      ended = await settleAudioTurn({ fb, player, rig, quietMs, grace, playerChangedAt: () => playerChangedAt }, Date.now(), timeoutMs);
    } finally {
      clearInterval(pump);
    }
    fb.drain();
    const evs = sliceAfter(client.events(), mark);
    const mime = phrases[0]?.mime;
    const base = buildTurn(label, evs, { ms: Date.now() - t0, ended, speech: { chunks: fb.speakChunks, bytes: fb.speakBytes, ...(mime ? { audioMime: mime } : {}) } });
    const p = rig.probe;
    if (fb.audioStripped) p.log.push("ВНИМАНИЕ озвучка пришла без байтов: подключайся connectLabClient({ keepAudio: true }), иначе звук не сохраняется");
    return {
      ...base,
      hearing: { wakeFired: p.wakeFired, gateOpened: p.gateOpened, rescueSent: p.rescueSent, ...(p.rescueVerdict ? { rescueVerdict: p.rescueVerdict } : {}), log: [...p.log] },
      transcript: recognized(evs),
      speechFiles: phrases,
      mode: realtime ? "realtime" : "fast",
      stats: { frames: frames.length, framesSent: p.framesSent, vad: [...p.vad], wakeKeywords: [...p.wakeKeywords], gateOpenReasons: [...p.gateOpenReasons], rescueCount: p.rescueCount, bargeIns: p.bargeIns, feedMs },
    };
  }

  const stand: AudioStandEx = {
    rig,
    outDir,
    sayWav: (wav, opts) => {
      const pcm = micChain(loadWav16k(wav), { preGain: opts?.preGain ?? o.preGain ?? 1, makeup: o.makeup ?? true });
      const frames = toFrames(pcm, opts?.tailSilenceMs ?? 1000);
      return run(typeof wav === "string" ? basename(wav) : "<wav>", frames, opts?.realtime ?? o.realtime ?? true, opts?.timeoutMs ?? 60_000);
    },
    async feedNoise(kind: NoiseKind, ms: number) {
      // Фон — про ЛОКАЛЬНЫЙ слух: гонится на виртуальных часах. «ok» — слух промолчал: гейт закрыт, KWS не сработал, в облако ни кадра.
      const frames = toFrames(micChain(makeNoise(kind, ms), { makeup: o.makeup ?? true }), 0);
      const r = await run(`[noise:${kind} ${ms}мс]`, frames, false, 30_000);
      return { ...r, ok: r.ended !== "timeout" && !r.hearing.gateOpened && !r.hearing.wakeFired && r.stats.framesSent === 0 };
    },
    async waitIdle(timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        fb.drain();
        if (fb.state === "idle" && !player.active) return true;
        await sleep(50);
      }
      return false;
    },
    async close() {
      player.dispose();
      rig.dispose();
    },
  };
  return stand;
}
