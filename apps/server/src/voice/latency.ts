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
  /** Чистое время синтеза первой фразы TTS: llm_first_token → tts_first_chunk. */
  ttsSynthMs?: number;
  /** Уложились ли в целевые 800 мс. */
  withinTarget?: boolean;
  /** Однострочная сводка по стадиям (для логов: видно, ГДЕ деградация). */
  summary: string;
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
    const llmFirstTokenMs = this.delta("turn_end", "llm_first_token");
    const ttsFirstChunkMs = this.delta("turn_end", "tts_first_chunk");
    const ttsSynthMs = this.delta("llm_first_token", "tts_first_chunk");
    const withinTarget = firstAudioMs === undefined ? undefined : firstAudioMs <= TARGET_FIRST_AUDIO_MS;
    return {
      marks: { ...this.marks },
      firstAudioMs,
      llmFirstTokenMs,
      ttsFirstChunkMs,
      ttsSynthMs,
      withinTarget,
      summary: buildSummary({ firstAudioMs, llmFirstTokenMs, ttsSynthMs, withinTarget }),
    };
  }
}

/** Однострочная сводка стадий — видно, где время (фраза→LLM доминирует / TTS / итог). */
function buildSummary(r: {
  firstAudioMs?: number;
  llmFirstTokenMs?: number;
  ttsSynthMs?: number;
  withinTarget?: boolean;
}): string {
  // Отрицательный/неполный firstAudioMs = фоновый/онбординг-оборот (метки не по порядку) — не шумим.
  if (r.firstAudioMs === undefined || r.firstAudioMs < 0) return "оборот неполный (фон/онбординг)";
  const ms = (n?: number): string => (n === undefined ? "—" : `${Math.round(n)}мс`);
  return (
    `фраза→LLM ${ms(r.llmFirstTokenMs)} · LLM→TTS ${ms(r.ttsSynthMs)} · →звук ${ms(r.firstAudioMs)} ` +
    `(цель ${TARGET_FIRST_AUDIO_MS}мс ${r.withinTarget ? "✓" : "✗"})`
  );
}
