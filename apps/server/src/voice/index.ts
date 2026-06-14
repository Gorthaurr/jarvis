/**
 * Голосовой слой (§10).
 *
 * АРХИТЕКТУРНОЕ РЕШЕНИЕ (§10): voice/ спроектирован как заменяемый рантайм со
 * стабильным контрактом (аудио внутрь / события наружу). В M1 пайплайн работает
 * IN-PROCESS внутри сервера (VoicePipeline), но контракт IVoiceProcess сохранён,
 * чтобы вынести оркестрацию в отдельный процесс (LiveKit Agents / Pipecat) без
 * правок brain/gateway — это будет замена реализации, а не переписывание мозга.
 *
 * STT/TTS — строго за интерфейсами (voice-providers.ts), провайдер заменяем (§1).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { VoicePipeline, type VoicePipelineDeps } from "./pipeline.js";

export { VoicePipeline } from "./pipeline.js";
export type { VoicePipelineDeps, AgentReplyLike } from "./pipeline.js";
export * from "./state.js";
export * from "./turn.js";
export * from "./latency.js";

const log: Logger = createLogger("voice");

/** Фабрика голосового пайплайна на сессию. */
export function createVoicePipeline(deps: VoicePipelineDeps): VoicePipeline {
  return new VoicePipeline(deps);
}

// ── Контракт отдельного голосового процесса (будущее, §10) ─────
// Сохранён намеренно: при выносе voice/ в отдельный процесс gateway будет
// общаться с ним через эти типы по IPC/WS, не зная про LiveKit/Pipecat.

export type VoiceOutEvent =
  | { kind: "transcript"; text: string; final: boolean }
  | { kind: "vad"; state: "speech_start" | "speech_end" | "barge_in" }
  | { kind: "audio_started" }
  | { kind: "audio_done" };

export type VoiceInCommand =
  | { kind: "speak"; text: string }
  | { kind: "stop" }
  | { kind: "set_followup"; ms: number };

export interface IVoiceProcess {
  send(cmd: VoiceInCommand): void;
  onEvent(cb: (e: VoiceOutEvent) => void): void;
  readonly running: boolean;
}

void log;
