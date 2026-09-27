/**
 * W3 V-1 (= L-9): `mouth_to_ear` закрывался на «Берусь, сэр», а итог промотированной задачи не мерился вовсе.
 * Теперь строка mouth_to_ear несёт firstSound (answer/ack/filler), а `first_answer` = turn_end → отправка первого
 * чанка СОДЕРЖАТЕЛЬНОГО ответа: path sync (ответ этим ходом) / promoted (итог фона, тот же turnSeq).
 * Проводка целиком: настоящий makeSessionContext → VoicePipeline → handleUserText → sync-first/промоушен →
 * speakResult → очередь озвучки; снаружи — управляемый STT, MockTts, медленная модель-скрипт.
 * Реверт-проверка (сделана): speakResult без answerOf в runActionSyncFirst — падает «промотированный ход»;
 * sink.done ack без `ack:true` — падает firstSound:"ack"; tier0 без answerOf — падает третий.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTtsProvider } from "../integrations/voice-providers.js";
import { metrics } from "../obs/metrics.js";
import { SlowLlm, voiceRig, withEnv } from "./test-support/voice-turn.js";

const ENV = { JARVIS_SYNC_PROMOTE_MS: "120", JARVIS_PLAYBACK_CONFIRM_MS: "0", JARVIS_THINK_EARCON_MS: "0" };

afterEach(() => vi.restoreAllMocks());

function spyMetrics() {
  const m2e = vi.spyOn(metrics, "recordMouthToEar").mockImplementation(() => {});
  const first = vi.spyOn(metrics, "recordFirstAnswer").mockImplementation(() => {});
  return { m2e, first };
}

describe("V-1: first_answer и firstSound через настоящий голосовой ход", () => {
  it("промотированный ход: m2e закрывается на ack (firstSound:'ack'), first_answer — на первом чанке ИТОГА, path promoted, тот же ход", async () => {
    await withEnv(ENV, async () => {
      const { m2e, first } = spyMetrics();
      const llm = new SlowLlm([{ toolUses: [{ id: "t1", name: "web_search", input: { query: "курс" } }] }, { text: "Нашёл, сэр: курс девяносто рублей." }], [200, 250]);
      const rig = voiceRig({ llm, tts: new MockTtsProvider() });
      rig.say("Джарвис, сделай долгую многошаговую штуку");
      // ack промоушена ушёл клиенту с тегом хода → клиент играет → audio.played
      await vi.waitFor(() => expect(rig.chunks.some((c) => c.gen !== undefined)).toBe(true), { timeout: 3_000, interval: 10 });
      const tag = rig.chunks.find((c) => c.gen !== undefined)!.gen!;
      expect(first).not.toHaveBeenCalled(); // «Берусь» — не ответ
      rig.ctx.voice.onAudioPlayed(tag, Date.now());
      expect(m2e).toHaveBeenCalledTimes(1);
      expect(m2e.mock.calls[0]).toEqual([expect.any(Number), tag, "u1", "ack"]);
      // итог фоновой задачи: очередь озвучки, без тега хода — но first_answer его ход знает
      await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1), { timeout: 4_000, interval: 10 });
      const [ms, seq, path, user] = first.mock.calls[0]!;
      expect([seq, path, user]).toEqual([tag, "promoted", "u1"]);
      expect(ms).toBeGreaterThanOrEqual(400); // обе реплики модели (200 + 250 мс) — до ответа, не до ack
      // первый чанк итога реально ушёл (без тега хода — m2e на него не замыкается)
      expect(rig.chunks.some((c) => c.gen === undefined)).toBe(true);
      expect(m2e).toHaveBeenCalledTimes(1);
    });
  }, 12_000);

  it("разговорный ответ этим ходом: first_answer path sync, m2e firstSound:'answer'", async () => {
    await withEnv(ENV, async () => {
      const { m2e, first } = spyMetrics();
      const rig = voiceRig({ llm: new SlowLlm([{ text: "Четыре, сэр." }], [150]), tts: new MockTtsProvider() });
      rig.say("Джарвис, сколько будет два плюс два?");
      await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1), { timeout: 3_000, interval: 10 });
      const tag = rig.chunks.find((c) => c.gen !== undefined)!.gen!;
      expect(first.mock.calls[0]!.slice(1)).toEqual([tag, "sync", "u1"]);
      expect(first.mock.calls[0]![0]).toBeGreaterThanOrEqual(140);
      rig.ctx.voice.onAudioPlayed(tag, Date.now());
      expect(m2e.mock.calls[0]).toEqual([expect.any(Number), tag, "u1", "answer"]);
    });
  }, 10_000);

  it("tier0 «открой X» затянулся: «Секунду, сэр» — ack (не ответ), итог запуска — first_answer promoted того же хода", async () => {
    await withEnv(ENV, async () => {
      const { m2e, first } = spyMetrics();
      const rig = voiceRig({ llm: new SlowLlm([], []), tts: new MockTtsProvider(), actionDelayMs: 400 });
      rig.say("Джарвис, открой блокнот");
      await vi.waitFor(() => expect(rig.chunks.some((c) => c.gen !== undefined)).toBe(true), { timeout: 3_000, interval: 10 });
      const tag = rig.chunks.find((c) => c.gen !== undefined)!.gen!;
      rig.ctx.voice.onAudioPlayed(tag, Date.now());
      expect(m2e.mock.calls[0]).toEqual([expect.any(Number), tag, "u1", "ack"]);
      await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1), { timeout: 4_000, interval: 10 });
      expect(first.mock.calls[0]!.slice(1)).toEqual([tag, "promoted", "u1"]);
      expect(rig.sendAction).toHaveBeenCalled(); // запуск реально ушёл клиенту
    });
  }, 10_000);
});
