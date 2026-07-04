/**
 * Раннер кода (§4, §6) — РЕАЛЬНОЕ исполнение для управления Windows.
 *
 * Политика (решение пользователя): Джарвис управляет системой сам, без урезания возможностей.
 * Раннер даёт настоящий доступ (реестр/службы/сеть/COM через python/node/powershell FullLanguage),
 * но с разумной обвязкой:
 *   - CWD = свежий временный каталог (mkdtemp) — чистая рабочая директория по умолчанию;
 *   - wall-clock таймаут + kill зависшего процесса (см. WALL_CLOCK_MS);
 *   - лимит размера stdout/stderr (усечение);
 *   - env пользователя БЕЗ секретов (runnerEnv вырезает *KEY/SECRET/TOKEN/…);
 *   - аргументы не интерполируются в shell (spawn без shell).
 *
 * Безопасность — КРИТИЧНЫЕ РЕЛЬСЫ §4 в серверном lint-гарде (brain/code-guard.ts): самозащита
 * (не убить себя), питание (только system_power), необратимое (удаление/формат → confirm).
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
// Реальные задачи (поставить модуль, просканировать систему, дёрнуть COM) дольше 10с. Окно
// настраивается env JARVIS_CODE_TIMEOUT_MS (деф. 30с, кламп [5с, 180с]). Долгое/фоновое — пусть
// агент гонит как фоновую задачу (§20), а не одним code.run.
const WALL_CLOCK_MS = (() => {
  const raw = Number.parseInt(process.env.JARVIS_CODE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) ? Math.min(180_000, Math.max(5_000, raw)) : 30_000;
})();

/**
 * Окружение для раннера: РЕАЛЬНЫЙ env пользователя (USERPROFILE/APPDATA/PATH/… — нужно для
 * настоящего управления Windows), но БЕЗ секретов: вырезаем ключи вида *KEY/SECRET/TOKEN/PASSWORD/
 * CREDENTIAL, чтобы скрипт (теперь с сетью) не мог их выгрузить.
 */
function runnerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/key|secret|token|password|passwd|credential/i.test(k)) continue;
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

export async function run(lang: CodeLang, code: string): Promise<CodeRunResult> {
  const cwd = await mkdtemp(join(tmpdir(), "jarvis-coderun-"));
  const { cmd, args } = interpreter(lang, code);
  log.info(`code.run ${lang} в ${cwd}`);

  try {
    return await new Promise<CodeRunResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: runnerEnv(),
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
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (r: CodeRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        truncated = true;
        // Убиваем ВСЁ дерево: на Windows child.kill бьёт только сам интерпретатор, а внуки
        // (subprocess/Start-Process/запущенный .exe) переусыновляются и продолжают жить/жечь
        // сеть/держать файлы в cwd. taskkill /T /F валит дерево целиком.
        killTree(child);
        // HARD-RESOLVE: если внуки держат pipe-дескрипторы stdout/stderr, событие 'close' родителя
        // может не прийти → промис висел бы вечно. Через 2с после kill завершаем принудительно.
        hardTimer = setTimeout(() => done({ stdout, stderr, exitCode: -1, truncated: true }), 2_000);
        hardTimer.unref?.();
      }, WALL_CLOCK_MS);

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
    await rmWithRetry(cwd);
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
