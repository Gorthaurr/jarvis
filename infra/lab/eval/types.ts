/**
 * Типы EVAL: надмножества контракта (lib/contracts.ts НЕ меняем — расширяем структурно, как LabServerHandle).
 * Контракт однотурновый (`ScenarioContext.turn`), а цели владельца бывают «запомни → вспомни» и «стоп посреди задачи»,
 * поэтому сценарий может добавить шаги, faults, опции сервисов ПК; проверка получает все ходы и снимки между ними.
 */
import type { ServiceOptions } from "../desktop/service-options.js";
import type { ConfirmPolicy, CheckResult, DesktopSeed, DesktopSnapshot, EvalReport, FakeDesktop, LabClient, LabClientOptions, LabServer, Scenario, ScenarioContext, ScenarioRun, TurnResult } from "../lib/contracts.js";
import type { LabClientConnectOptions } from "../lib/client.js";
import type { ConfirmDecision } from "../lib/policy.js";
import type { LabServerStartOptions } from "../lib/server.js";

/** Реплика владельца ПОСЛЕ цели (следующий ход того же разговора и той же партиции памяти). */
export interface EvalStep {
  say: string;
  /** Пауза ПЕРЕД репликой, мс: даёт фоновой задаче поработать (для «стоп» посреди дела). */
  pauseMs?: number;
  /** Ждать ли фоновые задачи до конца хода (по умолчанию да). */
  waitTasks?: boolean;
}

export interface EvalContext extends ScenarioContext {
  /** Все ходы по порядку; `turn` = последний. */
  turns: TurnResult[];
  /** Снимок «ПК» после каждого хода (marks[i] ↔ turns[i]) — чтобы видеть, что происходило между репликами. */
  marks: DesktopSnapshot[];
  /** Снимок сразу после сброса к seed, до первой реплики. */
  before: DesktopSnapshot;
  /** userId на сервере (= токен клиента): партиция памяти и напоминаний. */
  userId: string;
}

/** Один вызов «эталонного решения»: настоящий dispatchTool над FakeDesktop (tools/harness). */
export interface OracleCall {
  tool: string;
  args: Record<string, unknown>;
  confirm?: ConfirmPolicy;
  /** Эталонный вызов ЗАВЕДОМО возвращает ошибку инструмента (честный отказ) — тогда это не дефект эталона. */
  allowError?: boolean;
}

/** Эталон одного хода: что сделал бы толковый агент и что бы сказал. Нужен ТЕСТАМ проверок, раннер его не читает. */
export interface OracleTurn {
  calls: OracleCall[];
  answer: string;
  /** Состояния задач хода (для «стоп»: кто отменён), если ход их порождает. */
  tasks?: TurnResult["tasks"];
}

export interface EvalScenario extends Scenario {
  check(ctx: EvalContext): CheckResult | Promise<CheckResult>;
  /** Реплики после цели. */
  steps?: EvalStep[];
  /** Ждать ли фоновую задачу на ход с целью (false — вернуться на первом idle, чтобы прервать задачу «стоп»). */
  firstWaitTasks?: boolean;
  /** Пауза после последнего хода перед итоговым снимком, мс (проверка «после стопа ничего не происходит»). */
  settleMs?: number;
  faults?: LabClientOptions["faults"];
  /** Опции сервисов FakeDesktop (telegramUnconfirmed и т.п.); раннер применяет и сбрасывает — они глобальны в процессе. */
  services?: Partial<ServiceOptions>;
  /** Эталон по ходам (goal, затем steps). Без него сценарий не проверяется на «зелёное при достигнутой цели». */
  oracle?: OracleTurn[];
  /** id сценария-соседа, чей эталон для ЭТОГО — неверное поведение (проверка обязана покраснеть). */
  contrast?: string;
}

export type Outcome = "pass" | "fail" | "error";

export interface EvalRun extends ScenarioRun {
  outcome: Outcome;
  /** Раундов модели на сервере за прогон (0 — закрыл tier0/кэш без модели). */
  rounds: number;
  /** Что исчерпано: бюджет времени или действий (тогда pass=false, но это не ошибка прогона). */
  budget?: "time" | "actions";
  /** Прогон под `--brain off --control`: сценарий real-only, ожидание — КРАСНЫЙ. */
  control?: boolean;
  /** Ответов §14 не из политики (массив кончился): «нет» по умолчанию, не осознанное. */
  overflow?: number;
}

export interface EvalScenarioStats {
  pass: number;
  total: number;
  rate: number;
  medianMs: number;
  fail: number;
  error: number;
  tools: string[];
  control?: boolean;
}

export interface EvalReportX extends EvalReport {
  /** Контракт различает только scripted/real: `off` пишется как "scripted" (модели нет), точный режим — здесь. */
  mode: "off" | "real";
  control: boolean;
  label: string;
  finishedAt: string;
  runs: EvalRun[];
  bySrenario: Record<string, EvalScenarioStats>;
  /** Замечания раннера (например, сервер не остановился) — в отчёт, не в тишину. */
  notes: string[];
}

export type EvalClient = LabClient & { decisions?(): readonly ConfirmDecision[] };

/** Швы раннера: юниты подсовывают заглушки без процессов; по умолчанию — настоящие сервер, WS-клиент и FakeDesktop. */
export interface EvalDeps {
  startServer(o: LabServerStartOptions): Promise<LabServer>;
  connectClient(o: LabClientConnectOptions): Promise<EvalClient>;
  createDesktop(seed?: DesktopSeed): FakeDesktop;
}

export interface EvalOptions {
  brain: "off" | "real";
  n?: number;
  filter?: string;
  tag?: string;
  /** Только с brain:"off": гнать и real-only сценарии как ОТРИЦАТЕЛЬНЫЙ контроль (без модели цель обязана не достигаться). */
  control?: boolean;
  label?: string;
  deps?: Partial<EvalDeps>;
  /** Доп. env сервера поверх лабораторных. */
  serverEnv?: Record<string, string>;
  /** Пауза клиента после hello (онбординг сервера); по умолчанию — как у LabClient. */
  settleMs?: number;
  onRun?(run: EvalRun): void;
}
