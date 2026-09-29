/**
 * Запуск дочернего процесса с таймаутом и усечением вывода. Без shell и без .cmd-шимов (Windows): вызывающий даёт
 * process.execPath + путь к JS-входу. Таймаут убивает ДЕРЕВО (vitest-воркеры иначе остаются сиротами и портят замеры).
 */
import { spawn, spawnSync } from "node:child_process";
import type { ExecResult, ExecSpec } from "./types.js";

/** Сколько символов вывода держим в памяти; сверх — отбрасываем начало (итоги команд — в конце). */
export const CAPTURE_CAP = 2_000_000;

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // detached → своя группа
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* уже мёртв */ }
  }
}

export function runExec(spec: ExecSpec, cap = CAPTURE_CAP): Promise<ExecResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let truncated = false;
    let timedOut = false;
    let done = false;
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const take = (chunk: string): void => {
      out += chunk;
      if (out.length > cap) {
        out = out.slice(out.length - cap);
        truncated = true;
      }
    };
    for (const s of [child.stdout, child.stderr]) {
      s.setEncoding("utf8");
      s.on("data", take);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, spec.timeoutMs);
    const finish = (code: number | null, signal: string | null, extra = ""): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (extra) take(extra);
      resolve({ code, signal, timedOut, ms: Date.now() - t0, out, truncated });
    };
    child.on("error", (e) => finish(null, null, `\nне удалось запустить: ${e.message}\n`));
    child.on("close", (code, signal) => finish(code, signal));
  });
}
