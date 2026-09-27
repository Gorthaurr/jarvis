/**
 * W3 V-5: ack промоушена («Берусь, сэр», «Секунду, сэр») синтезировался вживую на первом ходе каждой фразы и подачи
 * (~180 мс до первого звука хода с руками). Теперь на старте сессии фразы прогоняются через CachingTtsProvider той же
 * подачей, что возьмёт пайплайн, — первый же промоушен звучит из кеша.
 * Проводка целиком: настоящий makeSessionContext (прогрев) → голосовой ход → sync-first → промоушен → ack в пайплайне;
 * внутренний TTS под кешем — шпион. Реверт-проверка (сделана): убрать вызов prewarmTts в router-ws — падает первый тест;
 * греть с opts=undefined вместо voice.voiceOpts() — падает первый (ключ кеша не совпал с подачей пайплайна).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ackPhrasesForTts } from "../brain/agent/promote-acks.js";
import { CachingTtsProvider } from "../integrations/tts-cache.js";
import { MockTtsProvider } from "../integrations/voice-providers.js";
import { prewarmTts } from "../voice/tts-prewarm.js";
import { SlowLlm, voiceRig, withEnv } from "./test-support/voice-turn.js";

const ENV = { JARVIS_SYNC_PROMOTE_MS: "120", JARVIS_PLAYBACK_CONFIRM_MS: "0", JARVIS_THINK_EARCON_MS: "0" };
const ACKS = ackPhrasesForTts();

afterEach(() => vi.restoreAllMocks());

describe("V-5: прогрев ack промоушена в кеше TTS", () => {
  it("после старта сессии промотированный ход говорит ack ИЗ КЕША: внутренний синтез на ack не зовётся", async () => {
    await withEnv(ENV, async () => {
      const inner = new MockTtsProvider();
      const innerSynth = vi.spyOn(inner, "synthesize");
      const tts = new CachingTtsProvider(inner);
      const outerSynth = vi.spyOn(tts, "synthesize");
      const llm = new SlowLlm([{ toolUses: [{ id: "t1", name: "web_search", input: { query: "курс" } }] }, { text: "Готово, сэр." }], [200, 0]);
      const rig = voiceRig({ llm, tts, voiceId: "filipp" });
      // прогрев — все служебные ack, подачей сессии
      await vi.waitFor(() => expect(innerSynth).toHaveBeenCalledTimes(ACKS.length), { timeout: 3_000, interval: 10 });
      expect(innerSynth.mock.calls.map((c) => c[0])).toEqual(ACKS);
      expect(innerSynth.mock.calls.every((c) => c[1]?.voiceId === "filipp")).toBe(true);
      await vi.waitFor(() => expect(tts.stats.size).toBe(ACKS.length), { timeout: 2_000, interval: 10 });
      innerSynth.mockClear();
      outerSynth.mockClear();

      rig.say("Джарвис, сделай долгую многошаговую штуку");
      await vi.waitFor(() => expect(rig.chunks.some((c) => c.gen !== undefined)).toBe(true), { timeout: 3_000, interval: 10 });
      const spokenAck = String(outerSynth.mock.calls[0]?.[0]);
      expect(ACKS).toContain(spokenAck); // первым прозвучал именно ack промоушена
      expect(innerSynth.mock.calls.map((c) => c[0])).not.toContain(spokenAck); // …и из кеша
    });
  }, 10_000);

  it("не кеширующий TTS не греем (прогрев там — чистая трата символов); сбой синтеза — не ошибка", async () => {
    const plain = new MockTtsProvider();
    const synth = vi.spyOn(plain, "synthesize");
    expect(await prewarmTts(plain, ACKS, undefined)).toBe(0);
    expect(synth).not.toHaveBeenCalled();
    const broken = new CachingTtsProvider({
      live: false,
      synthesize: () => {
        throw new Error("квота");
      },
    });
    expect(await prewarmTts(broken, ["Берусь, сэр."], undefined)).toBe(0);
  });
});
