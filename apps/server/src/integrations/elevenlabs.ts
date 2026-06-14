/**
 * TTS ElevenLabs через HTTP (§10, §21) — целый mp3 за один запрос.
 *
 * WS stream-input оказался ненадёжен (капризная авторизация/формат — голос мог
 * не звучать вовсе). HTTP-эндпоинт /v1/text-to-speech возвращает полный mp3 одним
 * ответом — клиент проигрывает его нативным <audio> целиком, без склейки чанков.
 * Нормализация произношения — на стороне ElevenLabs (§21). Без ключа/voiceId — Mock.
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

export interface ElevenLabsConfig {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
}

const DEFAULT_MODEL = "eleven_multilingual_v2";

/** Поток TTS поверх HTTP: один запрос → полный mp3 → один чанк (last=true). */
class ElevenLabsHttpStream implements TtsStream {
  private chunkCb?: (c: TtsChunk) => void;
  private errorCb?: (e: Error) => void;
  private doneCb?: () => void;
  private _cancelled = false;
  private done = false;
  private readonly controller = new AbortController();

  constructor(text: string, cfg: Required<Pick<ElevenLabsConfig, "apiKey" | "voiceId">> & ElevenLabsConfig) {
    void this.run(text, cfg);
  }

  private async run(
    text: string,
    cfg: Required<Pick<ElevenLabsConfig, "apiKey" | "voiceId">> & ElevenLabsConfig,
  ): Promise<void> {
    try {
      const model = cfg.modelId ?? DEFAULT_MODEL;
      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}` +
        `?output_format=mp3_44100_128`;
      const resp = await fetch(url, {
        method: "POST",
        signal: this.controller.signal,
        headers: {
          "xi-api-key": cfg.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: model,
          // Размеренная подача (манера Джарвиса), §21.
          voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true },
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${detail.slice(0, 140)}`);
      }
      const audio = await resp.arrayBuffer();
      if (this._cancelled) return;
      log.info("TTS синтез готов", { bytes: audio.byteLength });
      this.chunkCb?.({ audio, seq: 0, last: true });
      this.finish();
    } catch (e) {
      if (this._cancelled) return;
      log.warn("TTS ошибка", e instanceof Error ? e.message : String(e));
      this.errorCb?.(e instanceof Error ? e : new Error(String(e)));
      this.finish();
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
      this.controller.abort();
    } catch {
      /* уже завершён */
    }
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
}

export class ElevenLabsTtsProvider implements ITtsProvider {
  readonly live: boolean;
  constructor(private readonly cfg: ElevenLabsConfig) {
    this.live = Boolean(cfg.apiKey && cfg.voiceId);
    if (!this.live) log.warn("ElevenLabs не сконфигурирован (ключ/voiceId) — TTS в mock-режиме");
  }

  synthesize(text: string, opts?: TtsOpts): TtsStream {
    const voiceId = opts?.voiceId ?? this.cfg.voiceId;
    if (!this.cfg.apiKey || !voiceId) return new MockTtsStream(text);
    return new ElevenLabsHttpStream(text, { ...this.cfg, apiKey: this.cfg.apiKey, voiceId });
  }
}
