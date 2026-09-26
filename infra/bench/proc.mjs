// Стенд: процессы — запуск в своей группе (detached) с pid-файлом, проверка живости, гашение ТОЛЬКО своих групп.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidFile(runDir, name) {
  return join(runDir, `${name}.pid`);
}

export function readPid(runDir, name) {
  try {
    const n = Number.parseInt(readFileSync(pidFile(runDir, name), "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Запустить процесс лидером своей группы (kill(-pid) гасит и детей), stdout/stderr — в лог. */
export function spawnDetached(runDir, name, cmd, args, { env, cwd, logFile }) {
  mkdirSync(runDir, { recursive: true });
  const out = openSync(logFile, "a");
  const child = spawn(cmd, args, { env, cwd, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  writeFileSync(pidFile(runDir, name), String(child.pid));
  return child.pid;
}

export async function waitFor(fn, ms, step = 150) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* ещё не готово */
    }
    if (Date.now() >= until) return null;
    await sleep(step);
  }
}

/** Погасить свою группу: SIGTERM → ждём → SIGKILL. Чужие pid (без нашего pid-файла) не трогаем. */
export async function stopByPid(runDir, name, graceMs = 5_000) {
  const pid = readPid(runDir, name);
  if (pid && alive(pid)) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* уже нет */
      }
    }
    if (!(await waitFor(() => !alive(pid), graceMs))) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* уже нет */
      }
      await waitFor(() => !alive(pid), 2_000);
    }
  }
  rmSync(pidFile(runDir, name), { force: true });
  return pid;
}

/** Свободен ли TCP-порт на хосте (пробный listen). */
export function portFree(port, host = "127.0.0.1") {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}

/** Отвечает ли кто-то на TCP-порту. */
export function portOpen(port, host = "127.0.0.1") {
  return new Promise((res) => {
    const s = net.connect({ port, host });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
    s.setTimeout(1_000, () => (s.destroy(), res(false)));
  });
}

/** X-lock дисплея: свободен, наш, чужой живой или протухший. */
export function displayLock(display) {
  const f = `/tmp/.X${display.replace(":", "")}-lock`;
  if (!existsSync(f)) return { state: "free", file: f };
  const pid = Number.parseInt(readFileSync(f, "utf8").trim(), 10);
  return { state: alive(pid) ? "busy" : "stale", pid, file: f };
}
