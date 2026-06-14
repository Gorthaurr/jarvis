/**
 * Ограниченный раннер кода (§6).
 *
 * Рантайм-ограничения (§6), реализованные здесь:
 *   - CWD = свежий временный каталог (mkdtemp), а не рабочая папка пользователя;
 *   - wall-clock таймаут + kill зависшего процесса;
 *   - лимит размера stdout/stderr (усечение);
 *   - урезанный env (не пробрасываем секреты/полное окружение);
 *   - аргументы не интерполируются в shell (spawn без shell).
 *   - powershell — Constrained Language Mode (best-effort) + всегда confirm на сервере (§6).
 *
 * Дополнительный слой — серверный lint-гард (brain/code-guard.ts): реестр/службы/сеть/
 * системные пути отсекаются ДО отправки. Полная ФС-изоляция (Job Object, сетевой запрет
 * per-process) — // TODO(M3+): требует нативной обёртки/firewall-правила на exe раннера.
 *
 * НИКОГДА (§0 принцип 5): не печатать/не передавать карточные и платёжные данные.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeLang } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:code-runner");

export interface CodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

const MAX_OUTPUT = 64 * 1024; // 64 КБ на поток
const WALL_CLOCK_MS = 10_000;

/** Минимальный env: только то, что нужно интерпретатору; без секретов. */
function minimalEnv(): NodeJS.ProcessEnv {
  const e = process.env;
  return {
    PATH: e.PATH ?? e.Path,
    SystemRoot: e.SystemRoot,
    TEMP: e.TEMP,
    TMP: e.TMP,
    PATHEXT: e.PATHEXT,
  };
}

/** Команда и аргументы интерпретатора для языка (код передаётся как аргумент, не через shell). */
function interpreter(lang: CodeLang, code: string): { cmd: string; args: string[] } {
  switch (lang) {
    case "python":
      return { cmd: "python", args: ["-I", "-c", code] }; // -I: isolated mode
    case "node":
      return { cmd: "node", args: ["-e", code] };
    case "powershell":
      // CLM best-effort: ставим режим в начале сессии; -NoProfile/-NonInteractive обязательны.
      return {
        cmd: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; ${code}`,
        ],
      };
  }
}

export async function run(lang: CodeLang, code: string): Promise<CodeRunResult> {
  const cwd = await mkdtemp(join(tmpdir(), "jarvis-coderun-"));
  const { cmd, args } = interpreter(lang, code);
  log.info(`code.run ${lang} в ${cwd}`);

  try {
    return await new Promise<CodeRunResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: minimalEnv(),
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

      const timer = setTimeout(() => {
        truncated = true;
        child.kill("SIGKILL");
      }, WALL_CLOCK_MS);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (stdout = cap(stdout, d)));
      child.stderr.on("data", (d: string) => (stderr = cap(stderr, d)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: exitCode ?? -1, truncated });
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
