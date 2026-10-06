export { claimPort,isPortFree,LAB_PORT_MAX,LAB_PORT_MIN,LIVE_PORT,releasePort } from "./server-ports.js";
/**
 * Процессная часть лаб-сервера: выбор порта, запуск, проверка «это наш процесс», гашение ДЕРЕВА только своего pid.
 * Боевой сервер владельца (порт 8787) и его процессы здесь недостижимы по построению: порт 8787 запрещён, а убить можно
 * лишь pid, чья командная строка несёт метку `--lab-id=<id>` (защита от повторного использования pid после перезагрузки).
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./deps.js";

/** URL загрузчика tsx: bare `--import tsx` ищется от cwd, а cwd сервера — пустой каталог (иначе подцепится mcp.json репо). */
export function tsxLoaderUrl(): string {
  return pathToFileURL(repoRoot("apps/server/node_modules/tsx/dist/loader.mjs")).href;
}

export interface SpawnedServer {
  pid: number;
  /** Резолвится кодом выхода, когда процесс умер (null — убит сигналом). */
  exited: Promise<number | null>;
}

export interface SpawnOpts {
  id: string;
  cwd: string;
  env: Record<string, string>;
  logFile: string;
  /** true — сервер переживает родителя (CLI `up`). */
  detached?: boolean;
}

/** Запустить `apps/server/src/index.ts` под tsx. stdout+stderr — в файл (одна реализация logTail и для тестов, и для CLI). */
export function spawnServer(o: SpawnOpts): SpawnedServer {
  const fd = openSync(o.logFile, "a");
  const args = ["--import", tsxLoaderUrl(), repoRoot("apps/server/src/index.ts"), `--lab-id=${o.id}`];
  try {
    const child = spawn(process.execPath, args, {
      cwd: o.cwd,
      env: o.env,
      detached: o.detached === true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    if (!child.pid) throw new Error("процесс сервера не запустился (нет pid)");
    if (o.detached) child.unref();
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    return { pid: child.pid, exited };
  } finally {
    closeSync(fd); // ребёнок держит свою копию дескриптора
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Командная строка процесса (для сверки метки). undefined — не удалось узнать. */
export function commandLineOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`;
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 15_000 }, (err, out) =>
        resolve(err ? undefined : out.trim() || undefined),
      );
    } else {
      execFile("ps", ["-o", "command=", "-p", String(pid)], (err, out) => resolve(err ? undefined : out.trim() || undefined));
    }
  });
}

/** Наш ли это процесс: метка `--lab-id=<id>` в командной строке. Не смогли прочитать → НЕ наш (лучше не убить, чем убить чужой). */
export async function isOurProcess(pid: number, id: string): Promise<boolean> {
  if (!isPidAlive(pid)) return false;
  const cmd = await commandLineOf(pid);
  return cmd !== undefined && cmd.includes(`--lab-id=${id}`);
}

/** Синхронное гашение дерева (для process.on('exit')). Только pid, полученный от spawn в ЭТОМ процессе. */
export function killTreeSync(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* уже нет */
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Погасить дерево pid и дождаться смерти корня. */
export async function killTree(pid: number, waitMs = 10_000): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  killTreeSync(pid);
  const until = Date.now() + waitMs;
  while (isPidAlive(pid) && Date.now() < until) await sleep(100);
  return !isPidAlive(pid);
}

/** Дождаться /healthz. Прерывается, если процесс умер (`dead()`), — тогда ждать бессмысленно. */
export async function waitHealthz(httpUrl: string, timeoutMs: number, dead: () => boolean): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (dead()) return false;
    try {
      const r = await fetch(`${httpUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) return true;
    } catch {
      /* ещё не слушает */
    }
    await sleep(250);
  }
  return false;
}
