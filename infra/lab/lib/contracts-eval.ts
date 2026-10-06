import type { DesktopSeed, DesktopSnapshot } from "./contracts-desktop.js";
import type { ConfirmPolicy, LabServer, TurnResult } from "./contracts-transport.js";

// ───────────────────────── AudioStand ─────────────────────────

export interface AudioStandResult extends TurnResult {
  /** Что услышал ЛОКАЛЬНЫЙ слух клиента: сработал ли KWS, промахи, подстраховка, состояния гейта. */
  hearing: { wakeFired: boolean; gateOpened: boolean; rescueSent: boolean; rescueVerdict?: string; log: string[] };
  /** Текст, который распознал STT сервера для этой реплики (transcript). */
  transcript: string;
}

export interface AudioStand {
  /** Подать WAV (16 кГц mono s16le; другой формат — ресемплировать/отказать) через настоящий клиентский слух. */
  sayWav(wav: Buffer | string, opts?: { realtime?: boolean; tailSilenceMs?: number; timeoutMs?: number }): Promise<AudioStandResult>;
  /** Подать тишину/фон (проверка, что слух молчит). */
  feedNoise(kind: "silence" | "room" | "tv", ms: number): Promise<AudioStandResult>;
  close(): Promise<void>;
}

// ───────────────────────── Eval ─────────────────────────

export interface ScenarioContext {
  desktop: DesktopSnapshot;
  turn: TurnResult;
  server: LabServer;
}

export interface CheckResult {
  pass: boolean;
  /** Человеческое объяснение (что ожидали / что увидели) — идёт в отчёт. */
  why: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** Цель словами владельца — единственное, что получает мозг. НИКАКИХ подсказок про инструменты. */
  goal: string;
  tags: string[];
  /** Какие инструменты/виды команд/интенты этот сценарий ДОКАЗЫВАЕТ (для матрицы покрытия). */
  covers: string[];
  seed?: DesktopSeed;
  brain: "scripted" | "real" | "either";
  confirm?: ConfirmPolicy;
  budget: { maxMs: number; maxActions?: number };
  /** Проверка по ФАКТУ итогового состояния. */
  check(ctx: ScenarioContext): CheckResult | Promise<CheckResult>;
  /** Только «живьём»: нужен владелец/железо — сценарий описывает ЧТО проверять, раннер его пропускает с причиной. */
  liveOnly?: string;
}

export interface ScenarioRun {
  scenarioId: string;
  n: number;
  brain: "scripted" | "real";
  pass: boolean;
  why: string;
  ms: number;
  actions: number;
  tools: string[];
  answer: string;
  error?: string;
}

export interface EvalReport {
  startedAt: string;
  brain: "scripted" | "real";
  runs: ScenarioRun[];
  bySrenario: Record<string, { pass: number; total: number; rate: number; medianMs: number }>;
  skipped: Array<{ id: string; reason: string }>;
}

// ───────────────────────── Coverage ─────────────────────────

export interface CoverageRow {
  /** tool:<имя> | action:<kind> | intent:<kind> | flow:<id> */
  id: string;
  kind: "tool" | "action" | "intent" | "flow";
  /** unit | integration | lab-scripted | lab-real | live-only | none */
  coveredBy: string[];
  liveOnly?: string;
}

export interface CoverageMatrix {
  generatedAt: string;
  rows: CoverageRow[];
  totals: Record<string, number>;
  uncovered: string[];
}
