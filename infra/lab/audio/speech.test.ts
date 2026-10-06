import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mp3DurationMs, sniff, wavDurationMs } from "./audio-format.js";
import { FakePlayer } from "./fake-player.js";
import { fakeMp3 } from "./mock-client.js";
import { SpeechAssembler, SpeechStore } from "./speech-store.js";
import { parseWav, wavFromPcm16 } from "./wav.js";

const pcmChunk = (ms: number, last: boolean, gen = 1) => ({ audio: Buffer.alloc((ms * 24_000 * 2) / 1000), seq: 0, last, format: "pcm16", sampleRate: 24_000, gen });

describe("формат и длительность озвучки", () => {
  it("mp3: длительность из заголовков кадров (38 кадров MPEG1 L3 ≈ 993 мс), не оценка", () => {
    const d = mp3DurationMs(fakeMp3(1000));
    expect(d.estimated).toBe(false);
    expect(d.ms).toBeGreaterThan(985);
    expect(d.ms).toBeLessThan(1000);
  });

  it("mp3 после ID3v2-тега разбирается; мусор вместо mp3 — оценка по размеру с пометкой", () => {
    const tag = Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x0a", "binary"), Buffer.alloc(10)]);
    expect(mp3DurationMs(Buffer.concat([tag, fakeMp3(520)])).estimated).toBe(false);
    expect(mp3DurationMs(Buffer.alloc(16_000, 7)).estimated).toBe(true);
  });

  it("sniff различает mp3 / wav / pcm16 / бинарь; длительность wav из заголовка", () => {
    expect(sniff(fakeMp3(100))).toBe("mp3");
    const w = wavFromPcm16(new Int16Array(16_000));
    expect(sniff(w)).toBe("wav");
    expect(wavDurationMs(w)).toBe(1000);
    expect(sniff(Buffer.alloc(4), "pcm16")).toBe("pcm16");
    expect(sniff(Buffer.from("hello world!!"))).toBe("bin");
  });
});

describe("сборка фраз и сохранение", () => {
  it("pcm16-чанки играют по мере прихода, на last — WAV-файл с полной длиной", () => {
    const a = new SpeechAssembler();
    const r1 = a.push(pcmChunk(300, false));
    expect(r1.pieceMs).toBe(300);
    expect(r1.phrase).toBeNull();
    const r2 = a.push(pcmChunk(200, true));
    expect(r2.phrase?.kind).toBe("pcm16");
    expect(r2.phrase?.durationMs).toBe(500);
    const w = parseWav(r2.phrase!.data);
    expect(w.rate).toBe(24_000);
    expect(w.samples.length).toBe(12_000);
  });

  it("mp3 копится до last: до него играть нечего (pieceMs=null)", () => {
    const mp3 = fakeMp3(800);
    const a = new SpeechAssembler();
    expect(a.push({ audio: mp3.subarray(0, 1000), seq: 0, last: false }).pieceMs).toBeNull();
    const r = a.push({ audio: mp3.subarray(1000), seq: 1, last: true });
    expect(r.phrase?.kind).toBe("mp3");
    expect(r.pieceMs).toBeGreaterThan(780);
  });

  it("SpeechStore пишет файл с расширением по формату и байтами фразы", () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-audio-"));
    const store = new SpeechStore(dir);
    const a = new SpeechAssembler();
    const mp3 = store.save(1, a.push({ audio: fakeMp3(300), seq: 0, last: true }).phrase!);
    const wav = store.save(1, a.push(pcmChunk(100, true)).phrase!);
    expect(mp3.file?.endsWith(".mp3")).toBe(true);
    expect(wav.file?.endsWith(".wav")).toBe(true);
    expect(existsSync(mp3.file!)).toBe(true);
    expect(readFileSync(wav.file!).subarray(0, 4).toString()).toBe("RIFF");
    expect((mp3 as { data?: unknown }).data).toBeUndefined();
  });
});

describe("фейковый плеер", () => {
  function rig(rate: number) {
    const log: string[] = [];
    const p = new FakePlayer(
      {
        sendPlayback: (a) => log.push(`playback:${a}`),
        sendPlayed: (gen) => log.push(`played:${gen}`),
        setCoordinatorActive: (a) => log.push(`coord:${a}`),
        onPhrase: () => log.push("phrase"),
      },
      rate,
    );
    return { p, log };
  }
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("первый звук → playback:true + played(gen) ОДИН раз на gen; по окончании → playback:false", async () => {
    const { p, log } = rig(20); // 1 с звука играет 50 мс
    p.onChunk(pcmChunk(500, false));
    p.onChunk(pcmChunk(500, true));
    expect(log).toContain("playback:true");
    expect(log).toContain("coord:true");
    expect(p.active).toBe(true);
    await wait(150);
    expect(log.filter((l) => l === "played:1").length).toBe(1); // второй чанк того же gen — не новый «первый звук»
    expect(p.active).toBe(false);
    expect(log.at(-1)).toBe("playback:false");
    expect(log).toContain("coord:false");
    p.dispose();
  });

  it("новый gen — новый played; stop() (barge-in) немедленно гасит и сообщает серверу", async () => {
    const { p, log } = rig(1);
    p.onChunk(pcmChunk(5000, true, 1));
    p.onChunk(pcmChunk(5000, true, 2));
    expect(log.filter((l) => l.startsWith("played")).length).toBeGreaterThanOrEqual(1);
    p.stop();
    expect(p.active).toBe(false);
    expect(log.at(-1)).toBe("playback:false");
    p.dispose();
  });

  it("незаконченный pcm-поток держит «играет» (ждём хвост), а не выключает на паузе", async () => {
    const { p } = rig(50);
    p.onChunk(pcmChunk(100, false));
    await wait(120); // звук кончился, last нет
    expect(p.active).toBe(true);
    p.onChunk(pcmChunk(10, true));
    await wait(80);
    expect(p.active).toBe(false);
    p.dispose();
  });
});
