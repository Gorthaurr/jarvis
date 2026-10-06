/**
 * Двойник LabClient + СЦЕНАРНЫЙ «сервер» для тестов аудио-стенда без живого лаб-сервера. Ведёт себя как настоящий по
 * ключевым швам голоса: wake_local → listening; speech_end → chat{user} → thinking → speak.chunk(gen) → speaking; в покой
 * возвращается ТОЛЬКО после audio.playback{active:false} (как очередь речи настоящего сервера ждёт подтверждения динамика) —
 * поэтому стенд без фейкового плеера здесь упирается в таймаут, а не «проходит». Звук вне открытого гейта фиксируется в `received`.
 */
import type { LabClient } from "../lib/contracts.js";
import { wavFromPcm16 } from "./wav.js";

export type ReplyFormat = "pcm16" | "mp3" | "wav";
export interface MockScript {
  /** Что «распознал STT» (chat role=user). */
  transcript?: string;
  reply?: string;
  format?: ReplyFormat;
  /** Длительность озвучки, мс (деф 600). */
  speechMs?: number;
  /** Реакция на audio.wake_rescue: принять / принять «голое Джарвис» / молчать (как отказ или skipped). */
  rescue?: "accept" | "bare" | "silent";
  /** Задержка эндпоинта после speech_end, мс. */
  endpointMs?: number;
  /** Журнал — кольцо на N событий (как EventRecorder у LabClient: старое вытесняется, `events().length` перестаёт расти). */
  ringMax?: number;
  /** speak.chunk без байтов, только audioBytes — как connectLabClient без keepAudio. */
  stripAudio?: boolean;
}

/** Минимальный mp3: валидные заголовки MPEG1 Layer III 128 кбит/с 44,1 кГц (417 байт/кадр = 26,1 мс), полезная нагрузка — нули. */
export function fakeMp3(ms: number): Buffer {
  const frames = Math.max(1, Math.round(ms / 26.122));
  const f = Buffer.alloc(417);
  f.writeUInt32BE(0xfffb9000, 0);
  return Buffer.concat(Array.from({ length: frames }, () => f));
}

export interface MockClient extends LabClient {
  /** Всё, что клиент прислал серверу (тип + полезная нагрузка) — для проверок §0.6 и проводки. */
  received: Array<{ type: string; payload: Record<string, unknown> }>;
}

export function createMockClient(script: MockScript = {}): MockClient {
  const evs: ReturnType<LabClient["events"]> = [];
  const received: MockClient["received"] = [];
  const s: Required<Pick<MockScript, "transcript" | "reply" | "format" | "speechMs" | "rescue" | "endpointMs">> & MockScript = { transcript: "включи музыку", reply: "Включаю, сэр.", format: "pcm16" as ReplyFormat, speechMs: 600, rescue: "silent" as const, endpointMs: 150, ...script };
  let gen = 0;
  let gateOpen = false;
  const at = (): number => Date.now();
  const add = (e: ReturnType<LabClient["events"]>[number]): void => {
    evs.push(e);
    if (s.ringMax && evs.length > s.ringMax) evs.shift();
  };
  const push = (type: string, payload: unknown): void => add({ at: at(), dir: "in", type, payload });
  /** speak.chunk с учётом stripAudio. */
  const chunk = (audio: Buffer, rest: Record<string, unknown>): void => push("speak.chunk", s.stripAudio ? { ...rest, audioBytes: audio.length } : { audio: audio.toString("base64"), ...rest });
  const later = (ms: number, fn: () => void): void => void setTimeout(fn, ms).unref?.();

  const speak = (): void => {
    gen += 1;
    push("chat", { role: "user", text: s.transcript });
    push("client.state", { state: "thinking" });
    later(120, () => {
      push("client.state", { state: "speaking" });
      push("chat", { role: "assistant", text: s.reply });
      if (s.format === "pcm16") {
        const total = Math.round((s.speechMs / 1000) * 24_000);
        const half = Math.floor(total / 2);
        const tone = (n: number): Int16Array => Int16Array.from({ length: n }, (_, i) => Math.round(3000 * Math.sin(i / 8)));
        chunk(Buffer.from(tone(half).buffer), { seq: 0, last: false, format: "pcm16", sampleRate: 24_000, gen });
        chunk(Buffer.from(tone(total - half).buffer), { seq: 1, last: true, format: "pcm16", sampleRate: 24_000, gen });
      } else {
        const audio = s.format === "mp3" ? fakeMp3(s.speechMs) : wavFromPcm16(new Int16Array(Math.round((s.speechMs / 1000) * 16_000)));
        chunk(audio, { seq: 0, last: true, gen });
      }
    });
  };

  return {
    sessionId: "mock-session",
    userToken: "mock-token",
    received,
    say: async () => {
      throw new Error("mock: say() не нужен стенду");
    },
    events: () => [...evs],
    send(type, payload) {
      const p = (payload ?? {}) as Record<string, unknown>;
      received.push({ type, payload: p });
      add({ at: at(), dir: "out", type, payload });
      if (type === "audio.vad") {
        if (p.state === "wake_local") {
          gateOpen = true;
          push("client.state", { state: "listening" });
        }
        if (p.state === "speech_end" && gateOpen) later(s.endpointMs, speak);
      }
      if (type === "audio.wake_rescue" && s.rescue !== "silent") {
        later(200, () => {
          push("wake.rescue.result", { accepted: true, ...(s.rescue === "bare" ? { bare: true } : {}) });
          if (s.rescue === "accept") speak();
          else push("client.state", { state: "listening" });
        });
      }
      if (type === "audio.playback" && p.active === false) {
        gateOpen = false;
        later(50, () => push("client.state", { state: "idle" }));
      }
    },
    close: async () => {},
  };
}
