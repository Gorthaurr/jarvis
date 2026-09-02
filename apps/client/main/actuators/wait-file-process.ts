/**
 * Условия ожидания «работа кончилась» для wait_for (§Волна2 2.3; сценарии 2026-09-02, CAPABILITY_GAPS 3.14):
 *  - file: файл появился/исчез, причём «появился» ≠ «дописан» — `stableMs` требует, чтобы размер и mtime не
 *    менялись заданное время (рендер/экспорт/скачивание пишут файл долго), `minBytes` — что он не пустой;
 *  - process: процесс жив/завершился (по pid или имени образа) — итог фонового задания/сборки.
 * Чистый модуль без Electron/сайдкара (тестируется на реальной ФС и своём pid).
 */
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import type { WaitCondition } from "@jarvis/protocol";
import { expandPath } from "./fs.js";
import { assertReadable } from "./self-guard.js";

export type FileCond = Extract<WaitCondition, { kind: "file" }>;
export type ProcessCond = Extract<WaitCondition, { kind: "process" }>;

/** [выполнено?, что видели] — та же форма, что у checkOnce в sensors-cheap. */
export type Check = [boolean, string];

interface StableState {
  size: number;
  mtime: number;
  since: number;
}
/** Состояние стабилизации по пути — живёт между опросами одного ожидания (resetFileWait — перед новым). */
const stable = new Map<string, StableState>();

export function resetFileWait(cond: FileCond): void {
  stable.delete(expandPath(cond.path));
}

export function validateFileCond(cond: FileCond): void {
  if (!String(cond.path ?? "").trim()) throw new Error("wait_for file: пустой path");
  assertReadable(expandPath(cond.path)); // путь от модели: секреты не «ждём» и не сообщаем о них
}

export function validateProcessCond(cond: ProcessCond): void {
  const pid = cond.pid;
  const name = String(cond.name ?? "").trim();
  if ((pid === undefined || !Number.isInteger(pid) || pid <= 0) && !name) throw new Error("wait_for process: нужен pid (>0) или name (имя образа, напр. 'ffmpeg.exe')");
}

export async function checkFile(cond: FileCond, now = Date.now()): Promise<Check> {
  const abs = expandPath(cond.path);
  const st = await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  });
  if (!st) {
    stable.delete(abs);
    return [Boolean(cond.gone), "файла нет"];
  }
  if (cond.gone) return [false, `файл есть (${st.size} байт)`];
  const min = cond.minBytes ?? 1;
  if (st.size < min) return [false, `файл есть, но ${st.size} байт < minBytes ${min}`];
  const stableMs = cond.stableMs ?? 0;
  if (stableMs > 0) {
    const prev = stable.get(abs);
    if (!prev || prev.size !== st.size || prev.mtime !== st.mtimeMs) {
      stable.set(abs, { size: st.size, mtime: st.mtimeMs, since: now });
      return [false, `файл меняется (${st.size} байт) — жду стабилизации ${stableMs} мс`];
    }
    const held = now - prev.since;
    if (held < stableMs) return [false, `файл ${st.size} байт, не меняется ${held} мс из ${stableMs}`];
    return [true, `файл ${st.size} байт, не меняется ≥${stableMs} мс`];
  }
  return [true, `файл есть (${st.size} байт)`];
}

export async function checkProcess(cond: ProcessCond): Promise<Check> {
  const alive = await processAlive(cond);
  const who = cond.pid !== undefined ? `pid ${cond.pid}` : `«${cond.name}»`;
  return [cond.gone ? !alive : alive, alive ? `процесс ${who} жив` : `процесса ${who} нет`];
}

/** Жив ли процесс: по pid — сигнал 0 (EPERM = жив, чужой); по имени — tasklist. */
export async function processAlive(cond: ProcessCond): Promise<boolean> {
  if (cond.pid !== undefined && Number.isInteger(cond.pid) && cond.pid > 0) {
    try {
      process.kill(cond.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  const name = String(cond.name ?? "").trim();
  if (!name) return false;
  if (process.platform !== "win32") return false;
  const image = /\.exe$/iu.test(name) ? name : `${name}.exe`;
  const out = await new Promise<string>((res) => {
    const p = spawn("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], { windowsHide: true });
    let s = "";
    p.stdout?.on("data", (d: Buffer) => (s += d.toString("utf8")));
    p.on("error", () => res(""));
    p.on("close", () => res(s));
  });
  return out.toLowerCase().includes(`"${image.toLowerCase()}"`);
}
