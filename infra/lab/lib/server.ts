/**
 * startLabServer — ИЗОЛИРОВАННЫЙ настоящий сервер Джарвиса как отдельный процесс: свой порт (8811..8899, НИКОГДА 8787),
 * свой каталог %TEMP%/jarvis-lab/<id> с PGlite, env-файл лаборатории (боевой .env не читается), без MCP, не под
 * супервизором. Живой Джарвис владельца не затрагивается: чужие pid не убиваем, чужие каталоги не трогаем.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { LabServer, LabServerOptions } from "./contracts.js";
import { repoRoot } from "./deps.js";
import { assertPlainPath, assertSafeDir, prepareDir, removeRunDir } from "./server-dir.js";
import { planServerEnv, renderEnvFile } from "./server-env.js";
import { composeLogTail, readMetrics } from "./server-logs.js";
import { claimPort, isOurProcess, isPidAlive, killTree, killTreeSync, releasePort, spawnServer, waitHealthz } from "./server-proc.js";
import { type LabStateEntry, labRoot, readState, removeEntry } from "./server-state.js";

/** Расширение контракта (надмножество): управление жизнью каталога и процесса. */
export interface LabServerStartOptions extends LabServerOptions {
  /** Не удалять каталог прогона при stop() (логи/данные для разбора). По умолчанию удаляется. */
  keepDir?: boolean;
  /** Сервер переживает родительский процесс (CLI `up`). */
  detach?: boolean;
  /** Ожидание /healthz, мс (по умолчанию 60000). */
  startupTimeoutMs?: number;
}

export interface LabServerHandle extends LabServer {
  brain: string;
  stt: string;
  outLog: string;
  alive(): boolean;
  stop(o?: { keepDir?: boolean }): Promise<void>;
}

interface HandleInfo {
  id: string;
  port: number;
  dir: string;
  pid: number;
  devToken: string;
  brain: string;
  stt: string;
  /** Процесс запущен этим же процессом: его выход известен, pid не может быть «чужим». */
  owned?: { exited: () => boolean; onStop: () => void };
  keepDir: boolean;
}

/** Собрать LabServer над уже запущенным процессом (свежий старт или подключение по записи state.json). */
function makeHandle(i: HandleInfo): LabServerHandle {
  const dataDir = `${i.dir}/data`;
  const outLog = `${i.dir}/server.out.log`;
  const httpUrl = `http://127.0.0.1:${i.port}`;
  const alive = (): boolean => (i.owned ? !i.owned.exited() && isPidAlive(i.pid) : isPidAlive(i.pid));
  return {
    id: i.id, url: `ws://127.0.0.1:${i.port}/ws`, httpUrl, port: i.port, dir: i.dir, dataDir, devToken: i.devToken, pid: i.pid,
    brain: i.brain, stt: i.stt, outLog, alive,
    logTail: (lines = 60) => composeLogTail(outLog, dataDir, lines),
    metrics: () => readMetrics(dataDir),
    async health() {
      try {
        const r = await fetch(`${httpUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
        const j = (await r.json()) as { ok?: boolean; sessions?: number };
        return { ok: r.ok && j.ok === true, sessions: Number(j.sessions ?? 0) };
      } catch {
        return { ok: false, sessions: 0 };
      }
    },
    async stop(o) {
      if (alive()) {
        // Чужой pid (запись из state.json) убиваем, только сверив метку --lab-id в командной строке.
        if (!i.owned && !(await isOurProcess(i.pid, i.id))) throw new Error(`pid ${i.pid} не несёт метку --lab-id=${i.id} — не убиваю (возможно, pid переиспользован)`);
        if (!(await killTree(i.pid))) throw new Error(`не удалось погасить pid ${i.pid}`);
      }
      i.owned?.onStop();
      releasePort(i.port);
      removeEntry(i.id);
      if (!(o?.keepDir ?? i.keepDir)) await removeRunDir(i.dir);
    },
  };
}

/** Подключиться к серверу, поднятому раньше (запись реестра CLI). Процесс не запускается. */
export function attachLabServer(e: LabStateEntry): LabServerHandle {
  return makeHandle({ id: e.id, port: e.port, dir: e.dir, pid: e.pid, devToken: e.devToken, brain: e.brain, stt: e.stt, keepDir: false });
}

/** Миграции PGlite тем же раннером, что у боевого (сервер сам их не применяет). */
function migrate(pgdata: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [repoRoot("infra/migrate.mjs")], {
      cwd: repoRoot("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, DATABASE_URL: `pglite://${pgdata}` },
    });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (out += d));
    const t = setTimeout(() => p.kill(), 180_000);
    p.once("exit", (code) => {
      clearTimeout(t);
      code === 0 ? resolve() : reject(new Error(`миграции PGlite упали (код ${code}):\n${out.slice(-2000)}`));
    });
    p.once("error", reject);
  });
}

export async function startLabServer(opts: LabServerStartOptions = {}): Promise<LabServerHandle> {
  const brain = opts.brain ?? "off";
  if (brain === "scripted") {
    throw new Error("scripted не поддержан (brain:'scripted'): ScriptedLlm живёт только внутри bench-сессии (BenchSocket отвечает отказом на любое действие ПК) — WS-клиенту с FakeDesktop его не подключить без правки apps/server");
  }
  const id = `lab-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const dir = (opts.dir ?? `${labRoot()}/${id}`).split("\\").join("/").replace(/\/+$/u, "");
  assertPlainPath(dir);
  assertSafeDir(dir);
  const port = await claimPort(opts.port, readState().map((e) => e.port));
  const keepDir = opts.keepDir === true;
  let pid = 0;
  try {
    const sub = prepareDir(dir, id);
    const devToken = randomUUID();
    const plan = planServerEnv({ ...opts, brain, port, dataDir: sub.data, pgdata: sub.pgdata, devToken });
    writeFileSync(`${dir}/server.env`, renderEnvFile(plan.file), { mode: 0o600 });
    plan.proc.JARVIS_ENV_PATH = `${dir}/server.env`;
    await migrate(sub.pgdata, plan.proc);
    const child = spawnServer({ id, cwd: sub.cwd, env: plan.proc, logFile: `${dir}/server.out.log`, detached: opts.detach });
    pid = child.pid;
    let exited = false;
    void child.exited.then(() => (exited = true));
    const onExit = (): void => killTreeSync(child.pid);
    if (!opts.detach) process.once("exit", onExit); // тест упал/CLI убит — сервер-сирота не остаётся
    const handle = makeHandle({
      id, port, dir, pid, devToken, brain, stt: opts.stt ?? "mock", keepDir,
      owned: { exited: () => exited, onStop: () => process.off("exit", onExit) },
    });
    const up = await waitHealthz(handle.httpUrl, opts.startupTimeoutMs ?? 60_000, () => exited);
    if (!up) {
      const why = exited ? "процесс сервера завершился при старте" : `/healthz не ответил за ${(opts.startupTimeoutMs ?? 60_000) / 1000} с`;
      const tail = handle.logTail(40);
      await handle.stop({ keepDir: true }).catch(() => undefined);
      throw new Error(`лаб-сервер не поднялся: ${why}\n${tail}\n(каталог прогона оставлен: ${dir})`);
    }
    return handle;
  } catch (e) {
    if (!pid) {
      releasePort(port);
      if (!keepDir) await removeRunDir(dir); // до запуска процесса каталог наш и пуст от процессов
    }
    throw e;
  }
}
