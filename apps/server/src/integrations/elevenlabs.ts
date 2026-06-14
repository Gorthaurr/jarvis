/**
 * TTS-провайдер ElevenLabs (streaming, §10, §21).
 *
 * Реализует ITtsProvider (voice-providers.ts) поверх stream-input WebSocket —
 * первый аудио-чанк приходит после первого предложения (цель латентности §10).
 * Глобальный WebSocket Node 22; авторизация — поле xi_api_key в первом сообщении.
 * Нормализация произношения — на стороне ElevenLabs (§21), сырой SSML не шлём.
 * Без ключа/voiceId — MockTtsStream (стаб).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import {
  type ITtsProvider,
  MockTtsStream,
  type TtsChunk,
  type TtsOpts,
  type TtsStream,
} from "./voice-providers.js";

const log: Logger = createLogger("tts:elevenlabs");

interface WsEvent {
  data?: unknown;
  message?: string;
}
interface WsLike {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", cb: (ev: WsEvent) => void): void;
  readyState: number;
}
type WsCtor = new (url: string) => WsLike;

function getWebSocket(): WsCtor | undefined {
  return (globalThis as { WebSocket?: WsCtor }).WebSocket;
}

export interface ElevenLabsConfig {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
}

const DEFAULT_MODEL = "eleven_multilingual_v2";

export function buildElevenLabsUrl(voiceId: string, modelId = DEFAULT_MODEL): string {
  return `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?model_id=${encodeURIComponent(modelId)}`;
}

/**
 * Разобрать сообщение ElevenLabs (чистая функция — тест без сети).
 * Формат: { audio: base64|null, isFinal: boolean, ... }.
 * Возвращает декодированный чанк + флаг финала, либо null если ничего полезного.
 */
export function parseElevenLabsMessage(raw: unknown): { audio: ArrayBuffer | null; isFinal: boolean } | null {
  let msg: unknown = raw;
  if (typeof raw === "string") {
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { audio?: string | null; isFinal?: boolean };
  const isFinal = Boolean(m.isFinal);
  if (typeof m.audio === "string" && m.audio.length > 0) {
    const b = Buffer.from(m.audio, "base64");
    const audio = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return { audio, isFinal };
  }
  if (isFinal) return { audio: null, isFinal: true };
  return null;
}

class ElevenLabsTtsStream implements TtsStream {
  private ws: WsLike | null = null;
  private chunkCb?: (c: TtsChunk) => void;
  private errorCb?: (e: Error) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  private seq = 0;
  private done = false;

  constructor(
    text: string,
    cfg: Required<Pick<ElevenLabsConfig, "apiKey" | "voiceId">> & ElevenLabsConfig,
    WS: WsCtor,
  ) {
    try {
      this.ws = new WS(buildElevenLabsUrl(cfg.voiceId, cfg.modelId ?? DEFAULT_MODEL));
      this.ws.addEventListener("open", () => {
        if (this._cancelled || !this.ws) return;
        // BOS: настройки голоса + ключ; затем текст; затем EOS (пустой text).
        this.ws.send(
          JSON.stringify({
            text: " ",
            // Размеренная, спокойная подача (манера Джарвиса): выше stability.
            voice_settings: {
              stability: 0.6,
              similarity_boost: 0.8,
              style: 0.0,
              use_speaker_boost: true,
            },
            xi_api_key: cfg.apiKey,
          }),
        );
        this.ws.send(JSON.stringify({ text: `${text} `, try_trigger_generation: true }));
        this.ws.send(JSON.stringify({ text: "" }));
      });
      this.ws.addEventListener("message", (ev) => {
        if (this._cancelled) return;
        const data = typeof ev.data === "string" ? ev.data : ev.message;
        const parsed = parseElevenLabsMessage(data);
        if (!parsed) return;
        if (parsed.audio) {
          this.chunkCb?.({ audio: parsed.audio, seq: this.seq++, last: parsed.isFinal });
        }
        if (parsed.isFinal) this.finish();
      });
      this.ws.addEventListener("error", () => this.errorCb?.(new Error("elevenlabs ws error")));
      this.ws.addEventListener("close", () => this.finish());
    } catch (e) {
      this.errorCb?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private finish(): void {
    if (this.done || this._cancelled) return;
    this.done = true;
    this.doneCb?.();
  }

  onChunk(cb: (c: TtsChunk) => void): void {
    this.chunkCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errorCb = cb;
  }
  onDone(cb: () => void): void {
    this.doneCb = cb;
  }
  cancel(): void {
    this._cancelled = true;
    try {
      this.ws?.close();
    } catch {
      /* уже закрыт */
    }
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
}

export class ElevenLabsTtsProvider implements ITtsProvider {
  readonly live: boolean;
  constructor(private readonly cfg: ElevenLabsConfig) {
    this.live = Boolean(cfg.apiKey && cfg.voiceId) && getWebSocket() !== undefined;
    if (!cfg.apiKey || !cfg.voiceId) log.warn("ElevenLabs не сконфигурирован (ключ/voiceId) — TTS в mock-режиме");
    else if (getWebSocket() === undefined) log.warn("глобальный WebSocket недоступен — TTS в mock-режиме");
  }

  synthesize(text: string, opts?: TtsOpts): TtsStream {
    const WS = getWebSocket();
    const voiceId = opts?.voiceId ?? this.cfg.voiceId;
    if (!this.cfg.apiKey || !voiceId || !WS) return new MockTtsStream(text);
    return new ElevenLabsTtsStream(text, { ...this.cfg, apiKey: this.cfg.apiKey, voiceId }, WS);
  }
}
