import { describe, expect, it } from "vitest";
import { StreamAgc, buildDeepgramUrl, parseDeepgramMessage } from "./deepgram.js";
import { createSttProvider, createTtsProvider } from "./providers.js";
import type { TtsChunk } from "./voice-providers.js";

/** Пик амплитуды Int16-буфера в [0,1] (для проверки усиления). */
function peakOf(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  let peak = 0;
  for (let i = 0; i < buf.byteLength / 2; i += 1) peak = Math.max(peak, Math.abs(v.getInt16(i * 2, true)) / 32768);
  return peak;
}

/** Синтетический тихий синус Int16 с заданным пиком. */
function quietPcm(peak: number, n = 320): ArrayBuffer {
  const buf = new ArrayBuffer(n * 2);
  const v = new DataView(buf);
  for (let i = 0; i < n; i += 1) v.setInt16(i * 2, Math.round(Math.sin(i / 4) * peak * 32767), true);
  return buf;
}

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

  it("URL: keyterm по умолчанию ВЫКЛ (подозрение №1 «deepgram молчит на стриме», §10)", () => {
    const url = buildDeepgramUrl({ sampleRate: 16000, language: "ru" });
    expect(url).toContain("model=nova-3");
    expect(url).toContain("smart_format=true");
    expect(url).not.toContain("keyterm"); // по умолчанию keyterm НЕ шлём
  });

  it("URL: keyterm включается флагом DEEPGRAM_KEYTERM=1 (только nova-3)", () => {
    const prev = process.env.DEEPGRAM_KEYTERM;
    process.env.DEEPGRAM_KEYTERM = "1";
    try {
      expect(decodeURIComponent(buildDeepgramUrl({ sampleRate: 16000, language: "ru" }))).toContain("keyterm=Джарвис");
      // на nova-2 keyterm НЕ добавляем даже с флагом (валит WS-хендшейк)
      const prevM = process.env.DEEPGRAM_MODEL;
      process.env.DEEPGRAM_MODEL = "nova-2";
      try {
        const url = buildDeepgramUrl({ sampleRate: 16000, language: "ru" });
        expect(url).toContain("model=nova-2");
        expect(url).not.toContain("keyterm");
      } finally {
        if (prevM === undefined) delete process.env.DEEPGRAM_MODEL;
        else process.env.DEEPGRAM_MODEL = prevM;
      }
    } finally {
      if (prev === undefined) delete process.env.DEEPGRAM_KEYTERM;
      else process.env.DEEPGRAM_KEYTERM = prev;
    }
  });
});

describe("StreamAgc — усиление тихого STT-потока (§10)", () => {
  it("тянет тихий поток к целевому пику (Deepgram молчал на тихом raw-PCM)", () => {
    const agc = new StreamAgc(0.25, 6);
    const quiet = quietPcm(0.07); // браузерный autoGainControl даёт ~0.07
    expect(peakOf(quiet)).toBeLessThan(0.1);
    const boosted = agc.boost(quiet);
    expect(peakOf(boosted)).toBeGreaterThan(0.2); // поднят к целевому ~0.25
  });

  it("тишину НЕ раздувает (иначе фантомные транскрипты)", () => {
    const agc = new StreamAgc();
    const silence = new ArrayBuffer(640); // нули
    expect(peakOf(agc.boost(silence))).toBe(0);
  });

  it("не клиппует — остаётся в диапазоне Int16", () => {
    const agc = new StreamAgc(0.25, 6);
    const boosted = agc.boost(quietPcm(0.07));
    expect(peakOf(boosted)).toBeLessThanOrEqual(1);
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
