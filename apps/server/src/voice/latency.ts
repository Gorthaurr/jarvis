/**
 * Инструментирование латентности голосового пайплайна (§10, quality harness §22).
 *
 * Цель (§10): <800 мс от конца фразы до первого произнесённого слова. Метрика —
 * не таймаут: меряем по стадиям, чтобы видеть, где деградация (STT/LLM/TTS).
 * Часы инъектируются — трекер тестируется без реального времени.
 */
import { TARGET_FIRST_AUDIO_MS } from "@jarvis/protocol";
import type { LatencyStage } from "@jarvis/shared";

/** Метки стадий одного «оборота» реплики. turn_end — конец фразы пользователя. */
export type LatencyMark = "turn_end" | LatencyStage;

export interface LatencyReport {
  /** Абсолютные временные метки (мс) по стадиям. */
  marks: Partial<Record<LatencyMark, number>>;
  /** Главная метрика: turn_end → первый звук (§10). undefined, если стадии нет. */
  firstAudioMs?: number;
  /** turn_end → первый токен LLM. */
  llmFirstTokenMs?: number;
  /** turn_end → первый чанк TTS. */
  ttsFirstChunkMs?: number;
  /** Уложились ли в целевые 800 мс. */
  withinTarget?: boolean;
}

export class LatencyTracker {
  private marks: Partial<Record<LatencyMark, number>> = {};

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Поставить метку стадии (идемпотентно — первая запись стадии «выигрывает»). */
  mark(stage: LatencyMark): void {
    if (this.marks[stage] === undefined) this.marks[stage] = this.now();
  }

  /** Явно записать метку с конкретным временем (для дозаписи из колбэков). */
  markAt(stage: LatencyMark, ts: number): void {
    if (this.marks[stage] === undefined) this.marks[stage] = ts;
  }

  /** Сбросить (новый оборот реплики). */
  reset(): void {
    this.marks = {};
  }

  private delta(from: LatencyMark, to: LatencyMark): number | undefined {
    const a = this.marks[from];
    const b = this.marks[to];
    if (a === undefined || b === undefined) return undefined;
    return b - a;
  }

  report(): LatencyReport {
    const firstAudioMs = this.delta("turn_end", "audio");
    return {
      marks: { ...this.marks },
      firstAudioMs,
      llmFirstTokenMs: this.delta("turn_end", "llm_first_token"),
      ttsFirstChunkMs: this.delta("turn_end", "tts_first_chunk"),
      withinTarget: firstAudioMs === undefined ? undefined : firstAudioMs <= TARGET_FIRST_AUDIO_MS,
    };
  }
}
