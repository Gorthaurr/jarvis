import { describe, expect, it } from "vitest";
import { buildDeepgramUrl, parseDeepgramMessage } from "./deepgram.js";
import { createSttProvider, createTtsProvider } from "./providers.js";
import type { TtsChunk } from "./voice-providers.js";

describe("parseDeepgramMessage (§10)", () => {
  it("извлекает финальный транскрипт", () => {
    const msg = JSON.stringify({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "который час", confidence: 0.98 }] },
    });
    const p = parseDeepgramMessage(msg);
    expect(p).toEqual({ text: "который час", final: true, confidence: 0.98 });
  });

  it("interim-результат помечается final:false", () => {
    const p = parseDeepgramMessage({
      channel: { alternatives: [{ transcript: "кото" }] },
      is_final: false,
    });
    expect(p?.final).toBe(false);
    expect(p?.text).toBe("кото");
  });

  it("speech_final тоже считается финалом", () => {
    const p = parseDeepgramMessage({
      channel: { alternatives: [{ transcript: "стоп" }] },
      speech_final: true,
    });
    expect(p?.final).toBe(true);
  });

  it("пустой транскрипт → null", () => {
    expect(parseDeepgramMessage({ channel: { alternatives: [{ transcript: "  " }] } })).toBeNull();
    expect(parseDeepgramMessage("не json")).toBeNull();
    expect(parseDeepgramMessage({})).toBeNull();
  });

  it("URL содержит язык и sample_rate", () => {
    const url = buildDeepgramUrl({ sampleRate: 16000, language: "ru", interimResults: true });
    expect(url).toContain("language=ru");
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("interim_results=true");
  });
});

describe("фабрика провайдеров (§1)", () => {
  it("без ключей: STT → локальный whisper (live), TTS → mock", () => {
    // STT по умолчанию — локальный Whisper (без ключей, слух работает).
    expect(createSttProvider({}).live).toBe(true);
    expect(createSttProvider({ provider: "mock" }).live).toBe(false);
    expect(createTtsProvider({}).live).toBe(false);
  });

  it("STT с ключом открывает стрим через глобальный WebSocket (без сети)", () => {
    const g = globalThis as { WebSocket?: unknown };
    const orig = g.WebSocket;
    const calls: Array<{ url: string; protocols?: unknown }> = [];
    g.WebSocket = class {
      constructor(url: string, protocols?: unknown) {
        calls.push({ url, protocols });
      }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
      readyState = 0;
    } as unknown;
    try {
      const stt = createSttProvider({ deepgramApiKey: "key" });
      expect(stt.live).toBe(true);
      const stream = stt.open({ sampleRate: 16000, language: "ru" });
      expect(stream.live).toBe(true);
      expect(calls[0]?.url).toContain("language=ru");
      expect(calls[0]?.protocols).toEqual(["token", "key"]);
    } finally {
      g.WebSocket = orig;
    }
  });

  it("TTS с ключом+voiceId синтезирует через HTTP (мок fetch)", async () => {
    const g = globalThis as { fetch?: unknown };
    const orig = g.fetch;
    const fakeMp3 = new Uint8Array([1, 2, 3, 4]).buffer;
    const urls: string[] = [];
    g.fetch = async (url: string) => {
      urls.push(String(url));
      return { ok: true, arrayBuffer: async () => fakeMp3 } as unknown as Response;
    };
    try {
      const tts = createTtsProvider({ elevenLabsApiKey: "key", voiceId: "v1" });
      expect(tts.live).toBe(true);
      const stream = tts.synthesize("привет");
      const chunk = await new Promise<TtsChunk>((resolve) => stream.onChunk(resolve));
      expect(chunk.last).toBe(true);
      expect(chunk.audio.byteLength).toBe(4);
      expect(urls[0]).toContain("v1");
    } finally {
      g.fetch = orig;
    }
  });
});
