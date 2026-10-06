import { describe, expect, it, vi } from "vitest";
import { WindowsTtsProvider } from "./windows-tts.js";
import { createTtsProvider } from "./providers.js";

describe("offline voice", () => {
  it("явный windows/mock не включает ElevenLabs даже при наличии старого ключа", () => {
    vi.stubEnv("TTS_PROVIDER", "windows");
    expect(createTtsProvider({ elevenLabsApiKey: "unused", voiceId: "unused" })).toBeInstanceOf(WindowsTtsProvider);
    vi.stubEnv("TTS_PROVIDER", "mock");
    expect(createTtsProvider({ elevenLabsApiKey: "unused", voiceId: "unused" }).live).toBe(false);
    vi.unstubAllEnvs();
  });
  it("отмена до старта не создаёт процесс и не присылает позднее аудио", async () => {
    const onChunk = vi.fn(), onError = vi.fn(), onDone = vi.fn();
    const stream = new WindowsTtsProvider().synthesize("Тест");
    stream.onChunk(onChunk); stream.onError(onError); stream.onDone(onDone); stream.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.cancelled).toBe(true); expect(onChunk).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled();
  });
});
