import type { AudioStand, AudioStandResult, LabClient } from "../lib/contracts.js";
import type { HearingLoad, HearingRig } from "./hearing-rig.js";
import type { Phrase } from "./speech-store.js";
export class AudioStandUnavailable extends Error { }

export interface AudioStandOptions {
  client: LabClient;
  /** Каталог озвучки (по умолчанию %TEMP%/jarvis-lab/audio/<время>). */
  outDir?: string;
  /** Каталог моделей слуха (по умолчанию ~/.jarvis/models). */
  hearingDir?: string;
  /** Уже поднятые движки (loadHearing): sherpa грузится ~1,5 с — стенды по очереди могут делить один набор (не параллельно!). */
  hearing?: Extract<HearingLoad, { ok: true }>;
  /** Уровень «сырого микрофона» до makeup-кривой (см. mic-model.ts); 1 = WAV как есть. */
  preGain?: number;
  makeup?: boolean;
  /** По умолчанию true. */
  realtime?: boolean;
  /** Во сколько раз фейковый плеер играет быстрее реального (1 = реальный темп). */
  playbackRate?: number;
  /** Тишина сервера после конца хода, мс (деф 1000). */
  quietMs?: number;
  /** Сколько ждать, что сервер отреагирует на открытый гейт/подстраховку, мс (деф 8000: STT + эндпоинт + rescue-STT ≈ 4 с). */
  engageGraceMs?: number;
}

export interface AudioStandResultEx extends AudioStandResult {
  speechFiles: Phrase[];
  mode: "realtime" | "fast";
  stats: { frames: number; framesSent: number; vad: string[]; wakeKeywords: string[]; gateOpenReasons: string[]; rescueCount: number; bargeIns: number; feedMs: number };
}

export interface AudioStandEx extends AudioStand {
  sayWav(wav: Buffer | string, opts?: { realtime?: boolean; tailSilenceMs?: number; timeoutMs?: number; preGain?: number }): Promise<AudioStandResultEx>;
  feedNoise(kind: "silence" | "room" | "tv", ms: number): Promise<AudioStandResultEx>;
  /** Дождаться idle сервера (окно follow-up ≈12 с): иначе следующая реплика идёт без «Джарвис», как у живого клиента. */
  waitIdle(timeoutMs?: number): Promise<boolean>;
  readonly rig: HearingRig;
  readonly outDir: string;
}
