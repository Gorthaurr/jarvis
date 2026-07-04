/**
 * FillerCache (§10 realtime): прекеш дворецких филлеров для маскировки латентности Opus.
 * Проверяем прогрев из live-TTS, ротацию по кругу и graceful-режим без live-провайдера.
 */
import { describe, expect, it } from "vitest";
import {
  type ITtsProvider,
  MockTtsProvider,
  type TtsChunk,
  type TtsStream,
} from "../integrations/voice-providers.js";
import { FillerCache, synthesizeToBuffer } from "./filler-cache.js";

/** Live-TTS-заглушка: синтезирует детерминированные байты (длина = длина текста). */
class FakeLiveTtsStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  constructor(private readonly text: string) {
    queueMicrotask(() => this.run());
  }
  private run(): void {
    if (this._cancelled) return;
    this.chunkCb?.({ audio: new ArrayBuffer(Math.max(1, this.text.length)), seq: 0, last: true });
    if (!this._cancelled) this.doneCb?.();
  }
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
}
class FakeLiveTts implements ITtsProvider {
  readonly live = true;
  synthesize(text: string): TtsStream {
    return new FakeLiveTtsStream(text);
  }
}

describe("FillerCache (§10)", () => {
  it("прогрев из live-TTS кеширует филлеры, pick ротирует по кругу", async () => {
    const fc = new FillerCache();
    const n = await fc.warmup(new FakeLiveTts(), undefined, ["Раз.", "Два."]);
    expect(n).toBe(2);
    expect(fc.ready).toBe(true);
    expect(fc.size).toBe(2);
    const a = fc.pick();
    const b = fc.pick();
    const c = fc.pick();
    expect(a).not.toBeNull();
    expect(b).not.toBe(a); // разные филлеры
    expect(c).toBe(a); // 3-й = 1-й (ротация по кругу)
  });

  it("TTS не live (mock) → филлеров нет, pick=null, голос работает без них", async () => {
    const fc = new FillerCache();
    const n = await fc.warmup(new MockTtsProvider());
    expect(n).toBe(0);
    expect(fc.ready).toBe(false);
    expect(fc.pick()).toBeNull();
  });

  it("synthesizeToBuffer собирает чанки в один буфер", async () => {
    const buf = await synthesizeToBuffer(new FakeLiveTts(), "Привет");
    expect(buf).not.toBeNull();
    expect(buf!.byteLength).toBe(6); // длина «Привет»
  });
});
