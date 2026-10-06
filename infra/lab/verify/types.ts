/** Типы единого раннера проверок (pnpm verify). Шаги — ДАННЫЕ; раннер не знает ни про vitest, ни про tsc. */

export type ProfileName = "quick" | "verify" | "full";
export type StepStatus = "pass" | "fail" | "skip";

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}

export interface SkippedTest {
  file: string;
  name: string;
  /** Условие пропуска из ИСХОДНИКА теста (skipIf(...)) или честное «не найдено» — vitest причин не пишет. */
  reason: string;
}

/** Итог шага после разбора вывода. */
export interface StepOutcome {
  status: StepStatus;
  reason?: string;
  tests?: TestCounts;
  skipped?: SkippedTest[];
  /** Наблюдения, не влияющие на код выхода (известный долг, флейки из списка). */
  notes?: string[];
  /** «Зелёный, но не проверено»: что шаг НЕ доказал. */
  unverified?: string[];
}

export interface StepResult extends StepOutcome {
  id: string;
  title: string;
  ms: number;
  exitCode?: number | null;
  timedOut?: boolean;
  /** Хвост вывода дочернего процесса (усечён). */
  outputTail?: string;
}

export interface ExecSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  ms: number;
  /** Вывод stdout+stderr; при переполнении отброшено НАЧАЛО (итоги команд стоят в конце). */
  out: string;
  truncated: boolean;
}

export interface Ctx {
  root: string;
  profile: ProfileName;
  /** Ref, с которым сравниваем (origin/main или main); null — не нашли. */
  base: string | null;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Каталог артефактов шага (json-отчёты vitest и т.п.). */
  workDir: string;
  /** Каталог отчётов docs/lab/runs — для сравнения с прошлым прогоном. */
  runsDir: string;
}

export interface Step {
  id: string;
  title: string;
  profiles: ProfileName[];
  timeoutMs: number;
  /** Подряд идущие шаги с одной group идут параллельно (typecheck пакетов). */
  group?: string;
  /** Предусловие: отказ до запуска (skip с причиной или fail с причиной). */
  gate?: (ctx: Ctx, done: StepResult[]) => { status: "skip" | "fail"; reason: string } | null;
  /** Дочерний процесс. */
  exec?: (ctx: Ctx) => Omit<ExecSpec, "timeoutMs">;
  /** Разбор результата; по умолчанию код 0 = pass. */
  parse?: (res: ExecResult, ctx: Ctx) => StepOutcome | Promise<StepOutcome>;
  /** Шаг без одного дочернего процесса (флейк-скан, бенч, сравнение). Получает результаты предыдущих шагов. */
  inproc?: (ctx: Ctx, done: StepResult[]) => Promise<StepOutcome>;
}

export interface RunReport {
  version: 1;
  profile: ProfileName;
  startedAt: string;
  finishedAt: string;
  ms: number;
  base: string | null;
  host: { platform: string; node: string; chromePath: boolean };
  ok: boolean;
  steps: StepResult[];
  audit: {
    skippedTests: number;
    skippedSteps: Array<{ id: string; reason: string }>;
    unverified: string[];
  };
}
