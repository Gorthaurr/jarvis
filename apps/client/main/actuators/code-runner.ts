/**
 * Раннер кода (§4, §6) — РЕАЛЬНОЕ исполнение для управления Windows.
 *
 * Политика (решение пользователя): Джарвис управляет системой сам, без урезания возможностей.
 * Раннер даёт настоящий доступ (реестр/службы/сеть/COM через python/node/powershell FullLanguage),
 * но с разумной обвязкой:
 *   - CWD = свежий временный каталог (mkdtemp) по умолчанию; `cwd` от модели — для git/npm/тестов в
 *     репозитории (сценарии 2026-09-02: первый git-вызов падал «not a git repository» в temp-папке);
 *   - wall-clock таймаут + kill зависшего процесса (см. effectiveTimeoutMs: env-дефолт 30 с, кламп до 180 с,
 *     `timeoutMs` от модели — для прогонов тестов/сборок);
 *   - ФОНОВЫЕ ЗАДАНИЯ (`background:true`): процесс живёт дольше любого таймаута, вывод пишется в файлы,
 *     исход опрашивается `job.status` — «запустил» ≠ «сделал», результат сверяется по файлу/выводу;
 *   - лимит размера stdout/stderr (усечение);
 *   - env пользователя БЕЗ секретов (runnerEnv вырезает *KEY/SECRET/TOKEN/…);
 *   - аргументы не интерполируются в shell (spawn без shell).
 *
 * Безопасность — КРИТИЧНЫЕ РЕЛЬСЫ §4 в серверном lint-гарде (brain/code-guard.ts): самозащита
 * (не убить себя), питание (только system_power), необратимое (удаление/формат → confirm).
 * НИКОГДА (§0 принцип 5): не печатать/не передавать карточные и платёжные данные.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodeLang } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { JARVIS_SDK_PY } from "./jarvis-sdk-source.js";

const log = createLogger("actuator:code-runner");

/**
 * jarvis SDK (среда исполнения «1 раунд = вся задача»): координаты loopback-моста актуаторов. Ставится
 * на boot клиента (index.ts) через setActBridge; run() отдаёт их скрипту (env JARVIS_ACT_URL/TOKEN) и
 * кладёт `jarvis.py` на PYTHONPATH для python, чтобы модель драйвила актуаторы ОДНИМ скриптом. undefined → мост
 * не поднят (тесты/до boot): jarvis-скрипт честно упадёт (нет URL), обычный code_run работает как прежде.
 */
let actBridge: { port: number; token: string } | undefined;
export function setActBridge(bridge: { port: number; token: string } | undefined): void {
  actBridge = bridge;
}

export interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** Убит по wall-clock: exitCode -1 всегда (taskkill даёт процессу код 1 — без флага таймаут был неотличим от падения скрипта). */
  timedOut?: boolean;
}

export interface CodeRunOpts {
  /** Рабочий каталог (репозиторий для git/npm/тестов). Нет — свежая временная папка. */
  cwd?: string;
  /** Wall-clock таймаут этого запуска, мс (кламп [1 с, 180 с]); нет — env-дефолт (30 с). */
  timeoutMs?: number;
}

const MAX_OUTPUT = 64 * 1024; // 64 КБ на поток
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 180_000;

/** Дефолтное окно: env JARVIS_CODE_TIMEOUT_MS (кламп [5 с, 180 с]), иначе 30 с. Читается ЛЕНИВО (env после хойста). */
function defaultWallClockMs(): number {
  const raw = Number.parseInt(process.env.JARVIS_CODE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) ? Math.min(MAX_TIMEOUT_MS, Math.max(5_000, raw)) : 30_000;
}

/** Окно запуска: явный timeoutMs от модели (кламп), иначе дефолт. Экспорт — чтобы сервер/тесты считали то же. */
export function effectiveTimeoutMs(opts?: CodeRunOpts): number {
  const t = opts?.timeoutMs;
  if (typeof t === "number" && Number.isFinite(t)) return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(t)));
  return defaultWallClockMs();
}

/**
 * Окружение для раннера: РЕАЛЬНЫЙ env пользователя (USERPROFILE/APPDATA/PATH/… — нужно для
 * настоящего управления Windows), но БЕЗ секретов: вырезаем ключи вида *KEY/SECRET/TOKEN/PASSWORD/
 * CREDENTIAL, чтобы скрипт (теперь с сетью) не мог их выгрузить.
 *
 * Denylist по ИМЕНИ не ловит секрет в ЗНАЧЕНИИ безобидной переменной (DATABASE_URL=postgres://
 * user:PASS@host) — дополнительно вырезаем переменные, чьё значение похоже на URL с кредами
 * (scheme://user:pass@host).
 */
const CREDS_IN_URL_RE = /:\/\/[^/@\s]+:[^/@\s]+@/;

export function runnerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/key|secret|token|password|passwd|credential/i.test(k)) continue;
    if (v !== undefined && CREDS_IN_URL_RE.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Команда и аргументы интерпретатора для языка (код передаётся как аргумент, не через shell). */
function interpreter(lang: CodeLang, code: string): { cmd: string; args: string[] } {
  switch (lang) {
    case "python":
      return { cmd: "python", args: ["-c", code] }; // полный доступ к окружению/пакетам пользователя
    case "node":
      return { cmd: "node", args: ["-e", code] };
    case "powershell":
      // FullLanguage: Add-Type/COM/.NET доступны — без этого нельзя реально управлять Windows
      // (переключить аудиоустройство, дёрнуть COM-интерфейс и т.п.). Безопасность — рельсы §4 в
      // code-guard (самозащита/питание/необратимое), не урезание языка.
      return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", code] };
  }
}

/** Рабочий каталог: явный (обязан существовать и быть каталогом) или свежий временный. */
async function resolveCwd(cwd?: string): Promise<{ cwd: string; temp: boolean }> {
  const want = (cwd ?? "").trim();
  if (!want) return { cwd: await mkdtemp(join(tmpdir(), "jarvis-coderun-")), temp: true };
  const abs = resolve(want);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`code.run: cwd «${abs}» не существует — укажи существующий каталог (или не указывай cwd).`);
  if (!st.isDirectory()) throw new Error(`code.run: cwd «${abs}» — не каталог.`);
  return { cwd: abs, temp: false };
}

/**
 * env для запуска: jarvis SDK отдаём скрипту адрес+токен моста (JARVIS_ACT_TOKEN добавляем ПОСЛЕ runnerEnv —
 * тот вырезает *TOKEN* по имени, а этот токен раннеру нужен: он лишь пускает к локальному мосту с
 * allowlist-гейтом). ТОЛЬКО для python: SDK (jarvis.py) есть лишь под python, а node/powershell в мосте не
 * нуждаются — не даём им адрес/токен (defense-in-depth: меньше входов к мосту). `jarvis.py` кладём в
 * ОТДЕЛЬНЫЙ временный каталог на PYTHONPATH, а не в cwd: cwd теперь может быть репозиторием владельца.
 */
async function prepareEnv(lang: CodeLang): Promise<{ env: NodeJS.ProcessEnv; sdkDir?: string }> {
  const env: NodeJS.ProcessEnv = { ...runnerEnv() };
  if (!(actBridge && lang === "python")) return { env };
  env.JARVIS_ACT_URL = `http://127.0.0.1:${actBridge.port}/act`;
  env.JARVIS_ACT_TOKEN = actBridge.token;
  try {
    const sdkDir = await mkdtemp(join(tmpdir(), "jarvis-sdk-"));
    await writeFile(join(sdkDir, "jarvis.py"), JARVIS_SDK_PY, "utf8");
    env.PYTHONPATH = env.PYTHONPATH ? `${sdkDir};${env.PYTHONPATH}` : sdkDir;
    return { env, sdkDir };
  } catch (e) {
    log.warn("не удалось записать jarvis.py — SDK будет недоступен скрипту", { error: e instanceof Error ? e.message : String(e) });
    return { env };
  }
}

export async function run(lang: CodeLang, code: string, opts: CodeRunOpts = {}): Promise<CodeRunResult> {
  const { cwd, temp } = await resolveCwd(opts.cwd);
  const timeoutMs = effectiveTimeoutMs(opts);
  const { cmd, args } = interpreter(lang, code);
  const { env, sdkDir } = await prepareEnv(lang);
  log.info(`code.run ${lang} в ${cwd}`, { timeoutMs, tempCwd: temp });

  try {
    return await new Promise<CodeRunResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const cap = (cur: string, add: string): string => {
        if (cur.length >= MAX_OUTPUT) {
          truncated = true;
          return cur;
        }
        const room = MAX_OUTPUT - cur.length;
        if (add.length > room) truncated = true;
        return cur + add.slice(0, room);
      };

      let settled = false;
      let timedOut = false;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (r: CodeRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve(timedOut ? { ...r, exitCode: -1, timedOut: true } : r);
      };
      const timer = setTimeout(() => {
        truncated = true;
        timedOut = true;
        // Убиваем ВСЁ дерево: на Windows child.kill бьёт только сам интерпретатор, а внуки
        // (subprocess/Start-Process/запущенный .exe) переусыновляются и продолжают жить/жечь
        // сеть/держать файлы в cwd. taskkill /T /F валит дерево целиком.
        killTree(child);
        // HARD-RESOLVE: если внуки держат pipe-дескрипторы stdout/stderr, событие 'close' родителя
        // может не прийти → промис висел бы вечно. Через 2с после kill завершаем принудительно.
        hardTimer = setTimeout(() => done({ stdout, stderr, exitCode: -1, truncated: true }), 2_000);
        hardTimer.unref?.();
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (stdout = cap(stdout, d)));
      child.stderr.on("data", (d: string) => (stderr = cap(stderr, d)));
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        reject(e);
      });
      child.on("close", (exitCode) => {
        done({ stdout, stderr, exitCode: exitCode ?? -1, truncated });
      });
    });
  } finally {
    // На Windows после kill ОС может ещё держать дескрипторы файлов в cwd (особенно если выжили
    // внуки) → rm падает. Ретраим с задержкой, неуспех логируем (а не молча копим temp-каталоги).
    if (temp) await rmWithRetry(cwd);
    if (sdkDir) await rmWithRetry(sdkDir);
  }
}

// ── Фоновые задания (сценарии 2026-09-02: тесты/сборки/транскрипция/рендер не влезают ни в один таймаут) ──

export interface CodeJobStart {
  jobId: string;
  pid: number;
  cwd: string;
  logDir: string;
  startedAt: number;
}

export interface CodeJobStatus {
  jobId: string;
  lang: CodeLang;
  cwd: string;
  /** Процесс ещё идёт. false + exitCode — завершился (0 ≠ «результат есть»: сверяй файл/вывод). */
  running: boolean;
  exitCode?: number;
  elapsedMs: number;
  /** Хвост stdout/stderr (последние TAIL_CHARS символов из файлов лога). */
  stdoutTail: string;
  stderrTail: string;
  logDir: string;
  killed: boolean;
  /** Сбой запуска (интерпретатор не найден и т.п.). */
  error?: string;
}

interface Job {
  id: string;
  lang: CodeLang;
  cwd: string;
  tempCwd: boolean;
  sdkDir?: string;
  logDir: string;
  child: ChildProcess;
  startedAt: number;
  endedAt?: number;
  done: boolean;
  exitCode?: number;
  killed: boolean;
  error?: string;
  watchdog?: ReturnType<typeof setTimeout>;
}

const jobs = new Map<string, Job>();
/** Одновременных фоновых заданий — немного: это не очередь сборок, а «дождись, пока идут тесты». */
const MAX_RUNNING_JOBS = 4;
/** Потолок жизни задания: сутки — хватит любому рендеру; дольше = забытый процесс, убиваем честно. */
const JOB_MAX_MS = 24 * 60 * 60 * 1000;
/** Завершённое задание помним 6 ч (итог можно спросить позже), затем чистим логи. */
const JOB_RETENTION_MS = 6 * 60 * 60 * 1000;
const TAIL_CHARS = 4_000;

export async function startJob(lang: CodeLang, code: string, opts: CodeRunOpts = {}): Promise<CodeJobStart> {
  sweepJobs();
  const running = [...jobs.values()].filter((j) => !j.done).length;
  if (running >= MAX_RUNNING_JOBS) {
    throw new Error(`code.run: уже идут ${running} фоновых заданий — дождись их (job_status) или останови (job_status{kill:true}).`);
  }
  const { cwd, temp } = await resolveCwd(opts.cwd);
  const { cmd, args } = interpreter(lang, code);
  const { env, sdkDir } = await prepareEnv(lang);
  const logDir = await mkdtemp(join(tmpdir(), "jarvis-job-"));
  // Вывод — в файлы: процесс переживает любой таймаут, а хвост читается по job.status без pipe-буферов.
  const outFd = openSync(join(logDir, "stdout.log"), "a");
  const errFd = openSync(join(logDir, "stderr.log"), "a");
  let child: ChildProcess;
  try {
    child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ["ignore", outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const id = `job-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const job: Job = { id, lang, cwd, tempCwd: temp, sdkDir, logDir, child, startedAt: Date.now(), done: false, killed: false };
  jobs.set(id, job);
  const finish = (exitCode: number, error?: string): void => {
    if (job.done) return;
    job.done = true;
    job.exitCode = exitCode;
    job.endedAt = Date.now();
    if (error) job.error = error;
    if (job.watchdog) clearTimeout(job.watchdog);
    log.info("job завершилось", { id, exitCode, ms: job.endedAt - job.startedAt, killed: job.killed });
  };
  child.on("error", (e) => finish(-1, e.message));
  child.on("close", (code) => finish(code ?? -1));
  job.watchdog = setTimeout(() => {
    if (job.done) return;
    log.warn("job живёт дольше потолка — убиваю", { id, hours: JOB_MAX_MS / 3_600_000 });
    job.killed = true;
    killTree(child);
  }, JOB_MAX_MS);
  job.watchdog.unref?.();
  log.info(`code.run background ${lang} в ${cwd}`, { id, pid: child.pid });
  return { jobId: id, pid: child.pid ?? -1, cwd, logDir, startedAt: job.startedAt };
}

export async function jobStatus(jobId: string, kill = false): Promise<CodeJobStatus> {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`job_status: задание «${jobId}» неизвестно — id неверный или клиент перезапускался (реестр заданий живёт в памяти клиента).`);
  if (kill && !job.done) {
    job.killed = true;
    killTree(job.child);
  }
  const tail = async (name: string): Promise<string> => {
    const raw = await readFile(join(job.logDir, name)).catch(() => Buffer.alloc(0));
    const s = raw.toString("utf8");
    return s.length > TAIL_CHARS ? `…${s.slice(-TAIL_CHARS)}` : s;
  };
  return {
    jobId,
    lang: job.lang,
    cwd: job.cwd,
    running: !job.done,
    ...(job.done ? { exitCode: job.exitCode ?? -1 } : {}),
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    stdoutTail: await tail("stdout.log"),
    stderrTail: await tail("stderr.log"),
    logDir: job.logDir,
    killed: job.killed,
    ...(job.error ? { error: job.error } : {}),
  };
}

/** Идущие/завершённые задания (для паспорта/тестов). */
export function listJobs(): Array<{ jobId: string; running: boolean; startedAt: number }> {
  return [...jobs.values()].map((j) => ({ jobId: j.id, running: !j.done, startedAt: j.startedAt }));
}

/** Забытые завершённые задания: чистим логи/temp-cwd после retention. */
function sweepJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.done && j.endedAt !== undefined && now - j.endedAt > JOB_RETENTION_MS) {
      jobs.delete(id);
      void rmWithRetry(j.logDir);
      if (j.tempCwd) void rmWithRetry(j.cwd);
      if (j.sdkDir) void rmWithRetry(j.sdkDir);
    }
  }
}

/** Убить процесс вместе с деревом потомков (Windows: taskkill /T /F; иначе SIGKILL). */
function killTree(child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    try {
      const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      // КРИТично: незаслушанное async 'error' на ChildProcess (taskkill нет в PATH / EPERM) бросает
      // uncaught exception → краш main-процесса Electron. Слушаем и деградируем в SIGKILL.
      tk.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* уже мёртв */
        }
      });
      tk.unref?.();
      return;
    } catch {
      /* синхронный сбой spawn — падаем на SIGKILL ниже */
    }
  }
  child.kill("SIGKILL");
}

/** Удалить временный каталог с ретраями (хэндлы могут освободиться не сразу после kill). */
async function rmWithRetry(dir: string, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) {
        log.warn("не удалось удалить temp-каталог раннера", { dir, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
}
