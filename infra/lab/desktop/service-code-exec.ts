/**
 * Исполнители code.run для лаборатории. РЕАЛЬНЫЙ (child_process) включается только явным allowCodeExec: он даёт СВОЙ cwd
 * (свежая tmp-папка) и ВЫЧИЩЕННОЕ окружение (белый список имён — ни ключей, ни токенов владельца), но НЕ файловую изоляцию:
 * код видит диск. Поэтому по умолчанию он выключен, а для сценариев есть безопасный сценарный исполнитель.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeLang } from "@jarvis/protocol";

export interface CodeRequest {
  lang: CodeLang;
  code: string;
  /** Wall-clock окно запуска, мс (уже с клампом). */
  timeoutMs: number;
}

/** Форма как у CodeRunResult клиента + `durationMs` (сколько «идёт» фоновое задание в ВИРТУАЛЬНОМ времени; сценарный фейк). */
export interface CodeOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut?: boolean;
  stdoutTail?: string;
  durationMs?: number;
  pid?: number;
}

export interface CodeExecutor {
  /** signal.abort() убивает процесс (job.status{kill}). */
  run(req: CodeRequest, signal?: AbortSignal): Promise<CodeOutcome>;
}

const MAX_OUTPUT = 64 * 1024;
/** Имена, которые переносим из окружения хоста; ВСЁ остальное (в т.ч. любые *KEY/*TOKEN/*SECRET) не попадает в код. */
const ENV_ALLOW = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "LANG", "LC_ALL"];

export function scrubbedEnv(sandbox: string, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (host[k] !== undefined) env[k] = host[k];
  for (const k of ["TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) env[k] = sandbox;
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

function interpreter(lang: CodeLang, code: string): { cmd: string; args: string[] } {
  if (lang === "python") return { cmd: "python", args: ["-c", code] };
  if (lang === "node") return { cmd: process.execPath, args: ["-e", code] };
  return process.platform === "win32" ? { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", code] } : { cmd: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", code] };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* уже завершён */
    }
  }
}

export function realExecutor(): CodeExecutor {
  return {
    run: (req, signal) =>
      new Promise<CodeOutcome>((resolve) => {
        const sandbox = mkdtempSync(join(tmpdir(), "jarvis-lab-code-"));
        const { cmd, args } = interpreter(req.lang, req.code);
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const cap = (cur: string, add: string): string => {
          const room = MAX_OUTPUT - cur.length;
          if (add.length > room) truncated = true;
          return room > 0 ? cur + add.slice(0, room) : cur;
        };
        const child = spawn(cmd, args, { cwd: sandbox, env: scrubbedEnv(sandbox), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const done = (exitCode: number, extra: string = ""): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          try {
            rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
          } catch {
            /* tmp подчистит ОС */
          }
          resolve({ stdout, stderr: extra ? `${stderr}${extra}` : stderr, exitCode, truncated, ...(timedOut ? { timedOut: true } : {}), pid: child.pid });
        };
        const onAbort = (): void => {
          killTree(child.pid);
          done(-1);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
          done(-1);
        }, req.timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout = cap(stdout, d)));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = cap(stderr, d)));
        // Интерпретатор не найден и т.п.: честный exitCode -1 со стдерр-причиной, а не ложное «ok».
        child.on("error", (e) => done(-1, `запуск ${cmd} не удался: ${e.message}`));
        child.on("close", (code) => done(code ?? -1));
      }),
  };
}
