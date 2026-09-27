/**
 * W3 V-1: пайплайн различает, ЧЕМ был первый звук хода (answer / ack / filler), и когда ушёл первый СОДЕРЖАТЕЛЬНЫЙ
 * ответ. Настоящий VoicePipeline, MockTts; brain — скрипт стрима. Проводку через handleUserText/router-ws судит
 * gateway/first-answer-wiring.test.ts; здесь — ветки, которые туда не дотянуть (филлер, итог без хода, перебивание).
 * Реверт-проверка (сделана): playFiller с kind "answer" — падает первый; итог без answerOf не меряется — второй.
 */
import { describe, expect, it, vi } from "vitest";
import { sleep } from "@jarvis/shared";
import { MockTtsProvider, type SttPartial, type SttStream, type TtsChunk } from "../integrations/voice-providers.js";
import type { FillerCache } from "./filler-cache.js";
import { type ReplySink, VoicePipeline } from "./pipeline.js";

class Stt {
  readonly live = false;
  cb?: (p: SttPartial) => void;
  open(): SttStream {
    return {
      live: false,
      onPartial: (cb: (p: SttPartial) => void) => (this.cb = cb),
      onError() {},
      onClose() {},
      pushAudio() {},
      close: async () => {},
    } as unknown as SttStream;
  }
}

function rig(stream: (text: string, sink: ReplySink) => Promise<void>, filler = false) {
  const stt = new Stt();
  const chunks: TtsChunk[] = [];
  const m2e = vi.fn();
  const first = vi.fn();
  const pipe = new VoicePipeline({
    stt,
    tts: new MockTtsProvider(),
    onUserTurn: vi.fn(async () => ({ voice: "фолбэк" })),
    onUserTurnStream: stream,
    sendSpeakChunk: (c) => chunks.push(c),
    sendClientState: () => {},
    followupMs: 50,
    onMouthToEar: m2e,
    onFirstAnswer: first,
    ...(filler ? { filler: { ready: true, pick: () => new ArrayBuffer(8) } as unknown as FillerCache } : {}),
  });
  const say = (text: string) => {
    pipe.onWake();
    stt.cb!({ text, final: true });
  };
  return { pipe, chunks, m2e, first, say };
}

describe("V-1: firstSound и first_answer в пайплайне", () => {
  it("филлер «Секунду, сэр» первым: m2e firstSound:'filler', first_answer — на фразе ответа (sync), не на филлере", async () => {
    const r = rig(async (_t, sink) => {
      sink.thinking?.();
      await sleep(400); // модель думает дольше задержки филлера (250 мс)
      sink.sentence("Четыре, сэр.");
      sink.done("Четыре, сэр.");
    }, true);
    r.say("сколько будет два плюс два");
    await vi.waitFor(() => expect(r.chunks.length).toBeGreaterThan(0), { timeout: 2_000, interval: 10 });
    const tag = r.chunks[0]!.gen!;
    expect(r.first).not.toHaveBeenCalled(); // филлер ушёл — ответа ещё нет
    r.pipe.onAudioPlayed(tag, Date.now());
    expect(r.m2e).toHaveBeenCalledWith(expect.any(Number), tag, "filler");
    await vi.waitFor(() => expect(r.first).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 10 });
    expect(r.first.mock.calls[0]![0]).toBeGreaterThanOrEqual(390);
    expect(r.first.mock.calls[0]!.slice(1)).toEqual([tag, "sync"]);
  });

  it("ход закончился ack-ом: first_answer ждёт итог с answerOf этого хода; итог без хода и чужой ход — не меряются", async () => {
    const r = rig(async (_t, sink) => {
      sink.done("Берусь, сэр.", { origin: "proactive", ack: true });
    });
    r.say("сделай отчёт");
    await vi.waitFor(() => expect(r.chunks.length).toBeGreaterThan(0), { timeout: 2_000, interval: 10 });
    const tag = r.chunks[0]!.gen!;
    r.pipe.onAudioPlayed(tag, Date.now());
    expect(r.m2e).toHaveBeenCalledWith(expect.any(Number), tag, "ack");
    await sleep(80); // speak_done → канал свободен
    const prev = process.env.JARVIS_PLAYBACK_CONFIRM_MS;
    process.env.JARVIS_PLAYBACK_CONFIRM_MS = "0";
    try {
      r.pipe.speakQueued("Наблюдение сработало.", false, { origin: "proactive" }); // не итог хода
      r.pipe.speakQueued("Готово, сэр: отчёт собран.", false, { origin: "user-turn", answerOf: tag + 100 }); // чужой (неизвестный) ход
      await sleep(50);
      expect(r.first).not.toHaveBeenCalled();
      r.pipe.speakQueued("Готово, сэр: отчёт собран.", false, { origin: "user-turn", answerOf: tag });
      await vi.waitFor(() => expect(r.first).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 10 });
      expect(r.first.mock.calls[0]!.slice(1)).toEqual([tag, "promoted"]);
      r.pipe.speakQueued("И ещё одно.", false, { origin: "user-turn", answerOf: tag }); // второй итог того же хода
      await sleep(50);
      expect(r.first).toHaveBeenCalledTimes(1); // один first_answer на ход
    } finally {
      if (prev === undefined) delete process.env.JARVIS_PLAYBACK_CONFIRM_MS;
      else process.env.JARVIS_PLAYBACK_CONFIRM_MS = prev;
    }
  });
});
