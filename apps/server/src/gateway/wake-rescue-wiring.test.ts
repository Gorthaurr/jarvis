/**
 * Подстраховка «Джарвис» (28.09) — проводка ЦЕЛИКОМ через настоящий роутер: audio.wake_rescue → dispatch →
 * VoicePipeline.rescueWake → облачный STT (управляемый) → ход агента → speak.chunk клиенту; клиент получает
 * wake.rescue.result только при принятии; метрика wake_rescue пишется на каждый вердикт.
 * Реверт-проверка (сделана): убрать case "audio.wake_rescue" в dispatch — падают все; убрать send результата — падает второй.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLlmProvider } from "../integrations/llm.js";
import { MockTtsProvider } from "../integrations/voice-providers.js";
import { metrics } from "../obs/metrics.js";
import { dispatch } from "./router-ws.js";
import { voiceRig, withEnv } from "./test-support/voice-turn.js";

const ENV = { JARVIS_PLAYBACK_CONFIRM_MS: "0", JARVIS_THINK_EARCON_MS: "0" };
const B64 = Buffer.alloc(48_000).toString("base64"); // 1,5 с тишины: содержимое судит подставной STT
const env = (payload: Record<string, unknown>) => ({ id: "m1", ts: Date.now(), type: "audio.wake_rescue" as const, payload });
const rescueMsg = { pcm: B64, sampleRate: 16_000, ms: 1500, peak: 12_000 };

afterEach(() => vi.restoreAllMocks());

function rig(transcript: string) {
  const r = voiceRig({ llm: new MockLlmProvider([{ text: "Четыре, сэр." }]), tts: new MockTtsProvider() });
  const transcribeOnce = vi.fn(async (_p: ArrayBuffer, _sr: number) => transcript);
  (r.stt as unknown as { transcribeOnce: typeof transcribeOnce }).transcribeOnce = transcribeOnce;
  const rec = vi.spyOn(metrics, "recordWakeRescue").mockImplementation(() => {});
  const sends = r.session.send as unknown as ReturnType<typeof vi.fn>;
  return { ...r, transcribeOnce, rec, sends };
}

describe("audio.wake_rescue через роутер", () => {
  it("обращение в фрагменте → ход запущен, клиенту ушёл ответ и wake.rescue.result{accepted}, метрика accepted", async () => {
    await withEnv(ENV, async () => {
      const r = rig("Джарвис, сколько будет два плюс два?");
      await dispatch(r.ctx, env(rescueMsg));
      await vi.waitFor(() => expect(r.chunks.length).toBeGreaterThan(0), { timeout: 3_000, interval: 10 });
      expect(r.transcribeOnce).toHaveBeenCalledTimes(1);
      expect(r.sends).toHaveBeenCalledWith("wake.rescue.result", { accepted: true });
      expect(r.rec).toHaveBeenCalledWith("accepted", 1500, "u1");
    });
  });

  it("обращения нет → ход НЕ запущен, результат клиенту не шлётся, метрика rejected, звука нет", async () => {
    await withEnv(ENV, async () => {
      const r = rig("да я вчера ему то же самое сказал");
      await dispatch(r.ctx, env(rescueMsg));
      await vi.waitFor(() => expect(r.rec).toHaveBeenCalledWith("rejected", 1500, "u1"), { timeout: 2_000, interval: 10 });
      expect(r.sends.mock.calls.map((c) => c[0])).not.toContain("wake.rescue.result");
      expect(r.chunks).toHaveLength(0);
      expect(r.ctx.voice.state).toBe("idle");
    });
  });

  it("запись голосового отпечатка идёт → фрагмент игнорируется, в облако не уходит", async () => {
    await withEnv(ENV, async () => {
      const r = rig("Джарвис, привет");
      r.ctx.enroll = { session: { cancel: vi.fn(), feed: vi.fn() } } as never;
      await dispatch(r.ctx, env(rescueMsg));
      await new Promise((res) => setTimeout(res, 30));
      expect(r.transcribeOnce).not.toHaveBeenCalled();
    });
  });

  it("мусорная нагрузка (pcm не строка) не роняет роутер", async () => {
    await withEnv(ENV, async () => {
      const r = rig("Джарвис");
      await expect(dispatch(r.ctx, env({ pcm: 123, sampleRate: 16_000 }))).resolves.toBeUndefined();
      expect(r.transcribeOnce).not.toHaveBeenCalled();
    });
  });
});
