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
import type { AudioStand, AudioStandResult, LabClient, TurnResult } from "../lib/contracts.js";
import { FakePlayer } from "./fake-player.js";
import { sliceAfter } from "./event-cursor.js";
import { ServerFeedback } from "./feedback.js";
import { type HearingLoad, HearingRig, loadHearing } from "./hearing-rig.js";
import { micChain, toFrames } from "./mic-model.js";
import { type NoiseKind, makeNoise } from "./noise.js";
import { type Phrase, SpeechStore } from "./speech-store.js";
import { buildTurn, recognized } from "./turn-collect.js";
import { loadWav16k } from "./wav.js";

export class AudioStandUnavailable extends Error {}

export interface AudioStandOptions {
  client: LabClient;
  /** Каталог озвучки (по умолчанию %TEMP%/jarvis-lab/audio/<время>). */
  outDir?: string;
  /** Каталог моделей слуха (по умолчанию ~/.jarvis/models). */
  hearingDir?: string;
  /** Уже поднятые движки (loadHearing): sherpa грузится ~1,5 с — стенды по очереди могут делить один набор (не параллельно!). */
  hearing?: Extract<HearingLoad, { ok: true }>;
  /** Уровень «сырого микрофона» до makeup-кривой (см. mic-model.ts); 1 = WAV как есть. */
  preGain?: number;
  makeup?: boolean;
  /** По умолчанию true. */
  realtime?: boolean;
  /** Во сколько раз фейковый плеер играет быстрее реального (1 = реальный темп). */
  playbackRate?: number;
  /** Тишина сервера после конца хода, мс (деф 1000). */
  quietMs?: number;
  /** Сколько ждать, что сервер отреагирует на открытый гейт/подстраховку, мс (деф 8000: STT + эндпоинт + rescue-STT ≈ 4 с). */
  engageGraceMs?: number;
}

export interface AudioStandResultEx extends AudioStandResult {
  speechFiles: Phrase[];
  mode: "realtime" | "fast";
  stats: { frames: number; framesSent: number; vad: string[]; wakeKeywords: string[]; gateOpenReasons: string[]; rescueCount: number; bargeIns: number; feedMs: number };
}

export interface AudioStandEx extends AudioStand {
  sayWav(wav: Buffer | string, opts?: { realtime?: boolean; tailSilenceMs?: number; timeoutMs?: number; preGain?: number }): Promise<AudioStandResultEx>;
  feedNoise(kind: "silence" | "room" | "tv", ms: number): Promise<AudioStandResultEx>;
  /** Дождаться idle сервера (окно follow-up ≈12 с): иначе следующая реплика идёт без «Джарвис», как у живого клиента. */
  waitIdle(timeoutMs?: number): Promise<boolean>;
  readonly rig: HearingRig;
  readonly outDir: string;
}

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

  /** Ждём конец хода: сервер вернулся из thinking/speaking, плеер доиграл, задачи завершены, тишина quietMs. */
  async function settle(lastFrameAt: number, timeoutMs: number): Promise<TurnResult["ended"]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      fb.drain();
      const now = Date.now();
      if (now > deadline) return "timeout";
      const quiet = now - Math.max(fb.lastEventAt, playerChangedAt, lastFrameAt);
      const heard = rig.probe.gateOpened || rig.probe.rescueSent;
      if (!fb.engaged) {
        if (heard ? now - lastFrameAt >= grace : quiet >= quietMs) return "idle";
      } else if (fb.state !== "thinking" && fb.state !== "speaking" && !player.active && fb.tasksDone && quiet >= quietMs) {
        return fb.tasks.size > 0 ? "task_done" : "idle";
      }
      await sleep(25);
    }
  }

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
      ended = await settle(Date.now(), timeoutMs);
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
