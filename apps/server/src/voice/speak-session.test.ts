/**
 * PhraseSpeaker (§10 realtime): пофразная говорящая сессия. Проверяем главное —
 * speak_start ОДИН раз (на первом звуке первой фразы), speak_done ОДИН раз (после
 * последней), серийный порядок синтеза, и что barge-in рубит очередь без done.
 */
import { describe, expect, it } from "vitest";
import type { TtsChunk, TtsStream } from "../integrations/voice-providers.js";
import { PhraseSpeaker } from "./speak-session.js";

/** Управляемый TTS-стрим: chunk/done эмитим вручную из теста. */
class CtrlTts implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  constructor(readonly text: string) {}
  onChunk(cb: (c: TtsChunk) => void) {
    this.chunkCb = cb;
  }
  onError() {}
  onDone(cb: () => void) {
    this.doneCb = cb;
  }
  cancel() {
    this._cancelled = true;
  }
  get cancelled() {
    return this._cancelled;
  }
  chunk(seq = 0, last = true) {
    this.chunkCb?.({ audio: new ArrayBuffer(1), seq, last });
  }
  finishStream() {
    this.doneCb?.();
  }
}

function make(isLive: () => boolean = () => true) {
  const streams: CtrlTts[] = [];
  const chunks: TtsChunk[] = [];
  let speaking = 0;
  let done = 0;
  const speaker = new PhraseSpeaker({
    synthesize: (t) => {
      const s = new CtrlTts(t);
      streams.push(s);
      return s;
    },
    sendChunk: (c) => chunks.push(c),
    onSpeaking: () => {
      speaking += 1;
    },
    onDone: () => {
      done += 1;
    },
    isLive,
  });
  return { speaker, streams, chunks, counts: () => ({ speaking, done }) };
}

describe("PhraseSpeaker (§10)", () => {
  it("две фразы: speak_start один раз, серийный синтез, speak_done один раз", () => {
    const { speaker, streams, counts } = make();
    speaker.push("Первое предложение.");
    speaker.push("Второе предложение."); // в очередь, синтез ещё не начат

    expect(streams).toHaveLength(1); // синтезируем по очереди
    expect(streams[0]!.text).toBe("Первое предложение.");

    streams[0]!.chunk(); // первый звук первой фразы → speaking
    expect(counts().speaking).toBe(1);
    streams[0]!.finishStream(); // первая фраза готова → синтез второй

    expect(streams).toHaveLength(2);
    expect(streams[1]!.text).toBe("Второе предложение.");

    speaker.finish(); // brain закончил — но вторая ещё синтезируется
    expect(counts().done).toBe(0);

    streams[1]!.chunk();
    expect(counts().speaking).toBe(1); // НЕ второй speak_start
    streams[1]!.finishStream();

    expect(counts().done).toBe(1); // ровно один speak_done после последней
  });

  it("finish после слива очереди эмитит done сразу", () => {
    const { speaker, streams, counts } = make();
    speaker.push("Одна фраза.");
    streams[0]!.chunk();
    streams[0]!.finishStream(); // очередь пуста, finished ещё нет
    expect(counts().done).toBe(0);
    speaker.finish();
    expect(counts().done).toBe(1);
  });

  it("barge-in (cancel) рубит очередь и текущий синтез, done НЕ эмитится", () => {
    const { speaker, streams, chunks, counts } = make();
    speaker.push("Раз.");
    speaker.push("Два.");
    streams[0]!.chunk();
    speaker.cancel();
    expect(streams[0]!.cancelled).toBe(true);
    // поздние колбэки отменённого стрима игнорируются
    streams[0]!.chunk(1, true);
    streams[0]!.finishStream();
    expect(counts().done).toBe(0);
    expect(streams).toHaveLength(1); // вторую фразу синтезировать не начали
    expect(chunks).toHaveLength(1); // только до cancel
  });

  it("устаревшее поколение (isLive=false): чанки не шлются, done не эмитится", () => {
    let live = true;
    const { speaker, streams, chunks, counts } = make(() => live);
    speaker.push("Фраза.");
    live = false; // barge-in сменил gen
    streams[0]!.chunk();
    streams[0]!.finishStream();
    speaker.finish();
    expect(chunks).toHaveLength(0);
    expect(counts().speaking).toBe(0);
    expect(counts().done).toBe(0);
  });

  it("пустые/пробельные фразы игнорируются", () => {
    const { speaker, streams } = make();
    speaker.push("   ");
    speaker.push("");
    expect(streams).toHaveLength(0);
  });
});
