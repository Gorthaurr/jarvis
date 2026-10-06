import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
// @ts-expect-error infrastructure entrypoint is plain ESM
import { buildProfile, serializeProfile } from "../../no-api-profile.mjs";
const { parse } = createRequire(new URL("../../../apps/server/package.json", import.meta.url))("dotenv");
const saved = { TTS_PROVIDER: "yandex", YANDEX_VOICE: "filipp", YANDEX_SPEED: "1.2", YANDEX_EMOTION: "good",
  YANDEX_API_KEY: "fake-yandex-test-key", STT_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "fake-stt-test-key",
  ANTHROPIC_API_KEY: "fake-llm-test-key", OPENAI_API_KEY: "fake-openai-test-key", UNRELATED_SECRET: "not-for-profile" };
const options = { dataDir: "C:/scratch/jarvis", brain: "codex", port: 8788 };

describe("migration profile preserves configured audio", () => {
  it("retains exact voice, tuning and hearing credentials while changing only the LLM choice", () => {
    const profile = buildProfile(saved, options);
    expect(profile).toMatchObject({ TTS_PROVIDER: "yandex", YANDEX_VOICE: "filipp", YANDEX_SPEED: "1.2",
      YANDEX_EMOTION: "good", YANDEX_API_KEY: saved.YANDEX_API_KEY, STT_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: saved.DEEPGRAM_API_KEY, LLM_PROVIDER: "codex", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expect(profile).not.toHaveProperty("UNRELATED_SECRET");
  });
  it("uses offline voice and clears cloud audio credentials only when explicitly requested", () => {
    expect(buildProfile(saved, { ...options, brain: "local", offlineAudio: true })).toMatchObject({
      LLM_PROVIDER: "local", STT_PROVIDER: "whisper", TTS_PROVIDER: "windows", DEEPGRAM_API_KEY: "",
      YANDEX_API_KEY: "", ELEVENLABS_API_KEY: "", JARVIS_SUBSCRIPTION_FALLBACK: "0",
    });
    expect(buildProfile(saved, { ...options, brain: "local" }).TTS_PROVIDER).toBe("yandex");
  });
  it("round-trips profile values through the server dotenv parser without exposing secrets", () => {
    const profile = buildProfile({ ...saved, TTS_NOTE: "owner's # voice" }, options);
    expect(parse(serializeProfile(profile))).toEqual(profile);
  });
  it("preserves speech tempo adaptation and the configured Deepgram connection mode", () => {
    const tune = { JARVIS_TTS_SPEEDUP: "0", JARVIS_TTS_SPEEDUP_MAX: "1.07", JARVIS_DEEPGRAM_PERSISTENT: "0",
      JARVIS_DEEPGRAM_SEAL_QUIET_MS: "250" };
    expect(buildProfile({ ...saved, ...tune }, options)).toMatchObject(tune);
  });
  it("preserves a Windows model path containing an apostrophe and literal backslashes", () => {
    const profile = buildProfile({ WHISPER_MODEL: String.raw`C:\owner's\new-model` }, options);
    expect(parse(serializeProfile(profile))).toEqual(profile);
  });
});
