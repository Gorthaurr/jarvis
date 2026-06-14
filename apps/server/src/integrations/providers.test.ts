import { describe, expect, it } from "vitest";
import { buildDeepgramUrl, parseDeepgramMessage } from "./deepgram.js";
import { buildElevenLabsUrl, parseElevenLabsMessage } from "./elevenlabs.js";
import { createSttProvider, createTtsProvider } from "./providers.js";

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

describe("parseElevenLabsMessage (§21)", () => {
  it("декодирует base64-аудио", () => {
    const audioB64 = Buffer.from("RIFF....").toString("base64");
    const parsed = parseElevenLabsMessage(JSON.stringify({ audio: audioB64, isFinal: false }));
    expect(parsed?.audio).toBeInstanceOf(ArrayBuffer);
    expect(parsed?.audio?.byteLength).toBe(8);
    expect(parsed?.isFinal).toBe(false);
  });

  it("финал без аудио → {audio:null,isFinal:true}", () => {
    const parsed = parseElevenLabsMessage({ isFinal: true });
    expect(parsed).toEqual({ audio: null, isFinal: true });
  });

  it("сообщение без аудио и без финала → null", () => {
    expect(parseElevenLabsMessage({ foo: "bar" })).toBeNull();
    expect(parseElevenLabsMessage("nonjson")).toBeNull();
  });

  it("URL содержит voiceId и модель", () => {
    const url = buildElevenLabsUrl("voice123");
    expect(url).toContain("voice123");
    expect(url).toContain("eleven_multilingual_v2");
  });
});

describe("фабрика провайдеров (§1)", () => {
  it("без ключей → mock (live=false)", () => {
    expect(createSttProvider({}).live).toBe(false);
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

  it("TTS с ключом+voiceId открывает стрим через глобальный WebSocket (без сети)", () => {
    const g = globalThis as { WebSocket?: unknown };
    const orig = g.WebSocket;
    const urls: string[] = [];
    g.WebSocket = class {
      constructor(url: string) {
        urls.push(url);
      }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
      readyState = 0;
    } as unknown;
    try {
      const tts = createTtsProvider({ elevenLabsApiKey: "key", voiceId: "v1" });
      expect(tts.live).toBe(true);
      const stream = tts.synthesize("привет");
      expect(stream.cancelled).toBe(false);
      expect(urls[0]).toContain("v1");
    } finally {
      g.WebSocket = orig;
    }
  });
});
