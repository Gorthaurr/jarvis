/**
 * code.run / job.status FakeDesktop. Формы и тексты ошибок — как у клиента (actuators/index.ts, code-runner.ts):
 * ненулевой exitCode = `runtime` (не «успех с exitCode»), фоновое задание отвечает сразу с jobId, итог — job.status.
 * По умолчанию исполнителя НЕТ → честное «отключён в лаборатории» (ничего не выполнялось, эффектов нет).
 */
import type { ActionCommand } from "@jarvis/protocol";
import type { DesktopCore, KindHandlers } from "./core.js";
import { type CodeExecutor, type CodeOutcome, realExecutor } from "./service-code-exec.js";
import type { ServiceOptions } from "./service-options.js";
import { runState, vpath } from "./service-state.js";

type Cmd<K extends ActionCommand["kind"]> = Extract<ActionCommand, { kind: K }>;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RUNNING_JOBS = 4;
const JOB_LAB_MAX_MS = 10 * 60_000;
const TAIL_CHARS = 4_000;
const DISABLED = "code.run отключён в лаборатории: исполнитель не задан (setServiceOptions({allowCodeExec:true}) — реальный интерпретатор в tmp без файловой изоляции, либо codeExecutor — сценарный фейк)";

interface Job {
  id: string;
  lang: string;
  cwd: string;
  pid: number;
  startedAt: number;
  realStart: number;
  ctl: AbortController;
  killed: boolean;
  out?: CodeOutcome;
  /** Виртуальный момент завершения (сценарный фейк с durationMs): до него задание «идёт». */
  endAt?: number;
  scripted: boolean;
}

const tail = (s: string): string => (s.length > TAIL_CHARS ? `…${s.slice(-TAIL_CHARS)}` : s);

function executorOf(o: ServiceOptions): CodeExecutor | null {
  return o.codeExecutor ?? (o.allowCodeExec ? realExecutor() : null);
}

export function codeHandlers(core: DesktopCore, opts: () => ServiceOptions): KindHandlers {
  const st = (): { seq: number; jobs: Map<string, Job> } => runState(core, "jobs", () => ({ seq: 0, jobs: new Map<string, Job>() }));
  const tmpCwd = (): string => `${core.fs.home}/AppData/Local/Temp/jarvis-coderun-${st().seq + 1}`;

  /** cwd модели: существующий виртуальный каталог, иначе честная ошибка (как resolveCwd клиента). Пусто → tmp. */
  const cwdOf = (want: string | undefined): { cwd: string } | { error: string } => {
    if (!want?.trim()) return { cwd: tmpCwd() };
    const abs = vpath(core, want);
    if (core.fs.files.has(abs)) return { error: `code.run: cwd «${abs}» — не каталог.` };
    if (!core.fs.dirs.has(abs)) return { error: `code.run: cwd «${abs}» не существует — укажи существующий каталог (или не указывай cwd).` };
    return { cwd: abs };
  };

  const finished = (j: Job): boolean => j.killed || (j.out !== undefined && (j.endAt === undefined || core.now() >= j.endAt));

  function startJob(c: Cmd<"code.run">, ex: CodeExecutor, cwd: string, commandId: string) {
    const s = st();
    const running = [...s.jobs.values()].filter((j) => !finished(j)).length;
    if (running >= MAX_RUNNING_JOBS) {
      return core.fail(commandId, "runtime", `code.run: уже идут ${running} фоновых заданий — дождись их (job_status) или останови (job_status{kill:true}).`);
    }
    const job: Job = { id: `job-${++s.seq}`, lang: c.lang, cwd, pid: core.nextPid(), startedAt: core.now(), realStart: Date.now(), ctl: new AbortController(), killed: false, scripted: opts().codeExecutor !== undefined };
    s.jobs.set(job.id, job);
    void ex
      .run({ lang: c.lang, code: c.code, timeoutMs: JOB_LAB_MAX_MS }, job.ctl.signal)
      .then((r) => {
        if (job.killed) return;
        job.out = r;
        if (r.durationMs !== undefined) job.endAt = job.startedAt + r.durationMs;
      })
      .catch((e: unknown) => {
        job.out = { stdout: "", stderr: e instanceof Error ? e.message : String(e), exitCode: -1, truncated: false };
      });
    core.effect("code.job.start", { jobId: job.id, lang: c.lang, code: c.code.slice(0, 500) });
    return core.ok(commandId, { jobId: job.id, pid: job.pid, cwd, logDir: `${core.fs.home}/AppData/Local/Temp/jarvis-job-${job.id}`, startedAt: job.startedAt, background: true, note: "фоновое задание запущено; исход НЕ известен — проверяй job.status, результат сверяй по файлу/выводу" });
  }

  return {
    "code.run": async (cmd, meta) => {
      const c = cmd as Cmd<"code.run">;
      const ex = executorOf(opts());
      if (!ex) return core.fail(meta.commandId, "runtime", DISABLED);
      const cw = cwdOf(c.cwd);
      if ("error" in cw) return core.fail(meta.commandId, "runtime", cw.error);
      if (c.background) return startJob(c, ex, cw.cwd, meta.commandId);
      const timeoutMs = Number.isFinite(c.timeoutMs) ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(c.timeoutMs as number))) : DEFAULT_TIMEOUT_MS;
      const r = await ex.run({ lang: c.lang, code: c.code, timeoutMs });
      core.effect("code.run", { lang: c.lang, code: c.code.slice(0, 500), exitCode: r.exitCode, timedOut: r.timedOut === true, executor: opts().codeExecutor ? "scripted" : "real" });
      if (r.exitCode !== 0) {
        const why = r.timedOut ? " (ТАЙМАУТ: окно исполнения исчерпано, процесс убит — для долгого запуска задай timeoutMs или background:true)" : r.exitCode === -1 ? " (прервано)" : "";
        return core.fail(meta.commandId, "runtime", `код завершился с кодом ${r.exitCode}${why}. stderr: ${(r.stderr || "").slice(0, 500) || "(пусто)"}${r.stdout ? ` | stdout: ${r.stdout.slice(0, 300)}` : ""}`);
      }
      return core.ok(meta.commandId, { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, truncated: r.truncated, ...(r.stdoutTail !== undefined ? { stdoutTail: r.stdoutTail } : {}) });
    },

    "job.status": (cmd, meta) => {
      const c = cmd as Cmd<"job.status">;
      const j = st().jobs.get(c.jobId);
      if (!j) return core.fail(meta.commandId, "runtime", `job_status: задание «${c.jobId}» неизвестно — id неверный или клиент перезапускался (реестр заданий живёт в памяти клиента).`);
      if (c.kill === true && !finished(j)) {
        j.killed = true;
        j.ctl.abort();
        j.out = { stdout: j.out?.stdout ?? "", stderr: j.out?.stderr ?? "", exitCode: -1, truncated: false };
        core.effect("code.job.kill", { jobId: j.id });
      }
      const done = finished(j);
      return core.ok(meta.commandId, {
        jobId: j.id,
        lang: j.lang,
        cwd: j.cwd,
        running: !done,
        ...(done ? { exitCode: j.out?.exitCode ?? -1 } : {}),
        elapsedMs: j.scripted ? Math.min(core.now() - j.startedAt, j.endAt !== undefined ? j.endAt - j.startedAt : Infinity) : Date.now() - j.realStart,
        stdoutTail: done && j.out ? tail(j.out.stdout) : "",
        stderrTail: done && j.out ? tail(j.out.stderr) : "",
        logDir: `${core.fs.home}/AppData/Local/Temp/jarvis-job-${j.id}`,
        killed: j.killed,
      });
    },
  };
}
