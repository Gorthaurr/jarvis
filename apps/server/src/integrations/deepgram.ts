/**
 * STT-провайдер (Deepgram) — интерфейс + стаб (§10).
 *
 * Реальный стрим STT живёт в отдельном голосовом процессе (см. voice/index.ts);
 * здесь — контракт для серверной стороны на случай server-side транскрипции/тестов.
 * Без DEEPGRAM_API_KEY работает как no-op стаб.
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("stt");

/** Частичный/финальный результат распознавания. */
export interface SttResult {
  text: string;
  final: boolean;
}

export interface ISttProvider {
  /**
   * Транскрибировать кадр PCM. Возвращает результат или null (нет гипотезы).
   * Стрим/частичные результаты — за этим же интерфейсом в проде.
   */
  transcribe(pcm: ArrayBuffer, sampleRate: number): Promise<SttResult | null>;
  readonly live: boolean;
}

export class DeepgramSttProvider implements ISttProvider {
  readonly live: boolean;
  constructor(private readonly apiKey: string | undefined) {
    this.live = Boolean(apiKey);
    if (!this.live) log.warn("DEEPGRAM_API_KEY не задан — STT в стаб-режиме");
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async transcribe(_pcm: ArrayBuffer, _sampleRate: number): Promise<SttResult | null> {
    if (!this.live) return null;
    // TODO(M1): реальный вызов Deepgram (стриминг) из голосового процесса.
    void this.apiKey;
    return null;
  }
}
