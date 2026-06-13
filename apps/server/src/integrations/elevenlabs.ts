/**
 * TTS-провайдер (ElevenLabs) — интерфейс + стаб (§10).
 *
 * Синтез речи стримится клиенту как speak.chunk. Реальный стрим — в голосовом
 * процессе (voice/index.ts). Без ELEVENLABS_API_KEY — no-op стаб (пустой стрим).
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("tts");

/** Чанк синтезированного аудио. */
export interface TtsChunk {
  audio: ArrayBuffer;
  seq: number;
  last: boolean;
}

export interface ITtsProvider {
  /**
   * Синтезировать текст в аудиочанки. AsyncIterable, чтобы стримить speak.chunk
   * с минимальной задержкой до первого звука (§10, TARGET_FIRST_AUDIO_MS).
   */
  synthesize(text: string): AsyncIterable<TtsChunk>;
  readonly live: boolean;
}

export interface ElevenLabsConfig {
  apiKey: string | undefined;
  voiceId: string | undefined;
}

export class ElevenLabsTtsProvider implements ITtsProvider {
  readonly live: boolean;
  constructor(private readonly cfg: ElevenLabsConfig) {
    this.live = Boolean(cfg.apiKey && cfg.voiceId);
    if (!this.live) log.warn("ElevenLabs не сконфигурирован — TTS в стаб-режиме");
  }

  async *synthesize(text: string): AsyncIterable<TtsChunk> {
    if (!this.live) {
      // Стаб: ничего не произносим, только лог (звук появится в M1).
      log.debug("TTS стаб — нет аудио", { len: text.length });
      void this.cfg;
      return;
    }
    // TODO(M1): реальный стрим ElevenLabs из голосового процесса.
    return;
  }
}
