/**
 * W1 акустический смоук слуха на РЕАЛЬНОМ sherpa и корпусе WAV (TTS-голоса: filipp/alena/zahar/jane).
 * Пропускается честно, если модели не установлены (node apps/client/scripts/fetch-hearing-models.mjs).
 * Это первый акустический E2E в проекте: до W1 все пороги калибровались по жалобам владельца.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSherpaHearing, hearingModelsPresent, isAsciiPath, pcm16ToFloat } from "./sherpa-hearing.js";

const CORPUS = fileURLToPath(new URL("../../test-audio/", import.meta.url));
const have = hearingModelsPresent();

function readWav(p: string): Int16Array {
  const b = readFileSync(p);
  const d = b.subarray(44);
  return new Int16Array(d.buffer, d.byteOffset, Math.floor(d.length / 2));
}

describe.skipIf(!have)("sherpa hearing — реальные модели + корпус WAV", () => {
  it("«Джарвис» четырьмя голосами ловится локально; две чужие фразы (с «джаз/джип/Джордж») — нет", async () => {
    const h = await createSherpaHearing();
    expect(h).not.toBeNull();
    const files = readdirSync(CORPUS).filter((f) => f.endsWith(".wav"));
    const hits: Record<string, boolean> = {};
    for (const f of files) {
      const pcm = readWav(CORPUS + f);
      let hit = false;
      for (let off = 0; off + 320 <= pcm.length; off += 320) {
        if (h!.wake.process(pcm.subarray(off, off + 320))) hit = true;
      }
      h!.wake.reset();
      hits[f] = hit;
    }
    for (const f of files) {
      if (f.startsWith("pos_")) expect(hits[f], f).toBe(true);
      if (f.startsWith("neg_")) expect(hits[f], f).toBe(false);
    }
  });

  it("Silero VAD: на фразе есть speech_start и speech_end; на тишине — ничего", async () => {
    const h = await createSherpaHearing();
    const pcm = readWav(CORPUS + "pos_filipp_1.wav");
    const events: string[] = [];
    for (let off = 0; off + 320 <= pcm.length; off += 320) {
      const s = h!.vad.process(pcm.subarray(off, off + 320));
      if (s) events.push(s);
    }
    expect(events[0]).toBe("speech_start");
    expect(events).toContain("speech_end");
    h!.vad.reset();
    const silence = new Int16Array(16000);
    const quiet: string[] = [];
    for (let off = 0; off + 320 <= silence.length; off += 320) {
      const s = h!.vad.process(silence.subarray(off, off + 320));
      if (s) quiet.push(s);
    }
    expect(quiet).toEqual([]);
  });
});

describe("sherpa hearing — чистые хелперы", () => {
  it("isAsciiPath: кириллица в пути — не ASCII (sherpa такой путь не откроет)", () => {
    expect(isAsciiPath("C:/Users/anton/.jarvis/models")).toBe(true);
    expect(isAsciiPath("C:/Users/anton/Desktop/Автокомп/jarvis")).toBe(false);
  });
  it("pcm16ToFloat нормализует в [-1, 1]", () => {
    const f = pcm16ToFloat(new Int16Array([0, 16384, -32768]));
    expect(Array.from(f)).toEqual([0, 0.5, -1]);
  });
});
