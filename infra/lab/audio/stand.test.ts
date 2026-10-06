/**
 * Стенд целиком на НАСТОЯЩЕМ слухе (sherpa KWS + Silero + AudioCoordinator) и сценарном мок-сервере. Пропуск — только с причиной
 * (нет моделей): тихий skip неотличим от зелёного, поэтому причина печатается.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { audioStandAvailability, CORPUS_DIR } from "./availability.js";
import { createMockClient } from "./mock-client.js";
import { loadHearing } from "./hearing-rig.js";
import { createAudioStand } from "./stand.js";
import { loadWav16k, wavFromPcm16 } from "./wav.js";

const avail = audioStandAvailability();
if (!avail.ok) console.warn(`[audio-stand] SKIP: ${avail.reason}`);
const d = describe.skipIf(!avail.ok);
const shared = avail.ok ? await loadHearing() : null;
const hearing = shared?.ok ? shared : undefined;
const wav = (n: string): string => `${CORPUS_DIR}/${n}.wav`;
const types = (c: ReturnType<typeof createMockClient>): string[] => c.received.map((r) => (r.type === "audio.vad" ? `vad:${String(r.payload.state)}` : r.type));

/** Громкая речь БЕЗ «Джарвис» короче 4 с: KWS молчит, а клиентская подстраховка законно шлёт отрезок. */
function loudSpeechNoWake(): Buffer {
  const x = loadWav16k(wav("neg_jane_1")).slice(0, 3 * 16_000);
  return wavFromPcm16(Int16Array.from(x, (v) => Math.round(v * 32767)));
}

d("аудио-стенд: WAV → слух → (мок)сервер → озвучка", () => {
  it("«Джарвис, …»: KWS → wake_local → кадры ТОЛЬКО после него → ход → озвучка в файле, played/playback подтверждены", async () => {
    const client = createMockClient({ format: "pcm16", speechMs: 500 });
    const stand = await createAudioStand({ client, hearing, realtime: false, playbackRate: 10 });
    const r = await stand.sayWav(wav("pos_filipp_1"), { timeoutMs: 15_000 });
    const gateStillOpen = stand.rig.ac.streaming;
    await stand.close();

    expect(r.hearing.wakeFired).toBe(true);
    expect(r.hearing.gateOpened).toBe(true);
    const t = types(client);
    expect(t.indexOf("vad:wake_local")).toBeGreaterThanOrEqual(0);
    // §0.6: ни одного кадра до wake_local
    expect(t.indexOf("audio.frame")).toBeGreaterThan(t.indexOf("vad:wake_local"));
    expect(t).toContain("vad:speech_end");
    // ход дошёл до конца, и STT-транскрипт — это chat{user}
    expect(r.ended).toBe("idle");
    expect(r.ok).toBe(true);
    expect(r.transcript).toBe("включи музыку");
    expect(r.answer).toBe("Включаю, сэр.");
    // озвучка принята, посчитана и сохранена
    expect(r.speech.chunks).toBe(2);
    expect(r.speech.bytes).toBeGreaterThan(20_000);
    expect(r.speechFiles).toHaveLength(1);
    expect(r.speechFiles[0]?.durationMs).toBe(500);
    expect(existsSync(r.speechFiles[0]!.file!)).toBe(true);
    expect(readFileSync(r.speechFiles[0]!.file!).subarray(0, 4).toString()).toBe("RIFF");
    // сервер получил подтверждения плеера
    const playbacks = client.received.filter((x) => x.type === "audio.playback").map((x) => x.payload.active);
    expect(playbacks).toEqual([true, false]);
    const played = client.received.filter((x) => x.type === "audio.played");
    expect(played).toHaveLength(1);
    expect(played[0]?.payload.gen).toBe(1);
    // client.state=idle дошёл до координатора → гейт закрыт (звук между ходами в облако не идёт)
    expect(gateStillOpen).toBe(false);
  }, 30_000);

  it("mp3 и WAV-озвучка: правильное расширение и длительность", async () => {
    for (const format of ["mp3", "wav"] as const) {
      const client = createMockClient({ format, speechMs: 400 });
      const stand = await createAudioStand({ client, hearing, realtime: false, playbackRate: 10 });
      const r = await stand.sayWav(wav("pos_zahar_1"), { timeoutMs: 15_000 });
      await stand.close();
      expect(r.speechFiles[0]?.file?.endsWith(format === "mp3" ? ".mp3" : ".wav")).toBe(true);
      expect(Math.abs((r.speechFiles[0]?.durationMs ?? 0) - 400)).toBeLessThan(30);
      expect(r.speech.audioMime).toBe(format === "mp3" ? "audio/mpeg" : "audio/wav");
    }
  }, 40_000);

  it("чужая речь без «Джарвис» (neg_*): слух молчит — гейт закрыт, ни кадра, ни wake_local", async () => {
    const client = createMockClient();
    const stand = await createAudioStand({ client, hearing, realtime: false });
    const r = await stand.sayWav(wav("neg_alena_1"), { timeoutMs: 10_000 });
    await stand.close();
    expect(r.hearing.wakeFired).toBe(false);
    expect(r.hearing.gateOpened).toBe(false);
    expect(types(client).filter((x) => x === "audio.frame" || x === "vad:wake_local")).toEqual([]);
    expect(r.transcript).toBe("");
    expect(r.ended).toBe("idle");
  }, 20_000);

  it("feedNoise: тишина/комната/ТВ — ok только если слух промолчал и в облако не ушло ни кадра", async () => {
    const client = createMockClient();
    const stand = await createAudioStand({ client, hearing, realtime: false });
    for (const kind of ["silence", "room", "tv"] as const) {
      const r = await stand.feedNoise(kind, 6000);
      expect(r.hearing.wakeFired, kind).toBe(false);
      expect(r.stats.framesSent, kind).toBe(0);
      expect(r.ok, kind).toBe(true);
    }
    await stand.close();
    expect(types(client)).not.toContain("audio.frame");
  }, 30_000);

  it("подстраховка: KWS промолчал на громкой реплике → отрезок ушёл серверу → вердикт bare → гейт открыт", async () => {
    const client = createMockClient({ rescue: "bare" });
    const stand = await createAudioStand({ client, hearing, realtime: false, engageGraceMs: 1500 });
    const r = await stand.sayWav(loudSpeechNoWake(), { timeoutMs: 15_000, tailSilenceMs: 1200 });
    await stand.close();
    expect(r.hearing.wakeFired).toBe(false);
    expect(r.hearing.rescueSent).toBe(true);
    expect(r.hearing.rescueVerdict).toBe("bare");
    // вердикт дошёл до координатора: гейт открыт именно подстраховкой
    expect(r.stats.gateOpenReasons).toContain("wake-rescue");
    expect(types(client)).toContain("audio.wake_rescue");
    expect(r.hearing.log.some((l) => l.includes("wake-rescue: фрагмент отправлен"))).toBe(true);
    expect(r.hearing.log.some((l) => l.includes("wake-rescue"))).toBe(true);
    // до вердикта ни одного audio.frame (§0.6: только один rescue-фрагмент)
    expect(types(client).indexOf("audio.frame")).toBeGreaterThan(types(client).indexOf("audio.wake_rescue"));
  }, 30_000);

  it("сервер молчит на подстраховку: rescueVerdict = undefined (клиент не знает, отвергнуто или skipped), не «отвергнут»", async () => {
    const client = createMockClient({ rescue: "silent" });
    const stand = await createAudioStand({ client, hearing, realtime: false, engageGraceMs: 1200 });
    const r = await stand.sayWav(loudSpeechNoWake(), { timeoutMs: 15_000 });
    await stand.close();
    expect(r.hearing.rescueSent).toBe(true);
    expect(r.hearing.rescueVerdict).toBeUndefined();
    expect(r.hearing.gateOpened).toBe(false);
  }, 30_000);

  it("журнал-кольцо (как EventRecorder): переполнение посреди хода не гасит обратную связь — ответ и озвучка доходят", async () => {
    // ~220 исходящих кадров за ход при кольце на 120 событий: индексная привязка курсора здесь молча теряла бы client.state/speak.chunk.
    const client = createMockClient({ format: "pcm16", speechMs: 400, ringMax: 120 });
    const stand = await createAudioStand({ client, hearing, realtime: false, playbackRate: 10 });
    const r = await stand.sayWav(wav("pos_filipp_1"), { timeoutMs: 15_000 });
    await stand.close();
    expect(r.ended).toBe("idle");
    expect(r.speech.chunks).toBe(2);
    expect(r.speechFiles).toHaveLength(1);
    expect(client.received.filter((x) => x.type === "audio.playback").map((x) => x.payload.active)).toEqual([true, false]);
    expect(r.transcript).toBe("включи музыку");
  }, 30_000);

  it("аудио вырезано клиентом (нет keepAudio): байты считаются по audioBytes, файлов нет, в логе честное предупреждение", async () => {
    const client = createMockClient({ format: "pcm16", speechMs: 400, stripAudio: true });
    const stand = await createAudioStand({ client, hearing, realtime: false, playbackRate: 10 });
    const r = await stand.sayWav(wav("pos_filipp_1"), { timeoutMs: 15_000 });
    await stand.close();
    expect(r.speech.chunks).toBe(2);
    expect(r.speech.bytes).toBeGreaterThan(10_000);
    expect(r.speechFiles).toEqual([]);
    expect(r.hearing.log.join(" | ")).toContain("keepAudio");
  }, 30_000);

  it("realtime: кадры идут в реальном темпе (20 мс/кадр), а не пачкой", async () => {
    const client = createMockClient({ speechMs: 300 });
    const stand = await createAudioStand({ client, hearing, realtime: true, playbackRate: 10 });
    const r = await stand.sayWav(wav("pos_alena_1"), { timeoutMs: 30_000, tailSilenceMs: 300 });
    await stand.close();
    const expectedMs = r.stats.frames * 20;
    expect(r.mode).toBe("realtime");
    expect(r.stats.feedMs).toBeGreaterThan(expectedMs * 0.9);
    expect(r.stats.feedMs).toBeLessThan(expectedMs * 1.5);
    expect(r.hearing.wakeFired).toBe(true);
  }, 40_000);
});
