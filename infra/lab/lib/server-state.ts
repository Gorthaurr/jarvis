/**
 * Реестр запущенных лаб-серверов между вызовами CLI: %TEMP%/jarvis-lab/state.json. Нужен, чтобы `lab.ts say|down|log`
 * нашли сервер, поднятый `lab.ts up` в другом процессе. Токен здесь — dev-токен ИЗОЛИРОВАННОГО сервера, не секрет владельца.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export interface LabStateEntry {
  id: string;
  port: number;
  dir: string;
  dataDir: string;
  pid: number;
  devToken: string;
  brain: string;
  stt: string;
  /** Токен пользователя лаб-клиента: один на сервер, чтобы последовательные `say` делили память. */
  clientToken: string;
  startedAt: string;
}

/** Корень всех прогонов лаборатории (ASCII-путь вне репозитория). */
export function labRoot(): string {
  return `${tmpdir().split("\\").join("/").replace(/\/$/u, "")}/jarvis-lab`;
}

export const statePath = (): string => `${labRoot()}/state.json`;

export function readState(): LabStateEntry[] {
  try {
    const v: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
    return Array.isArray(v) ? (v as LabStateEntry[]) : [];
  } catch {
    return []; // нет файла / битый — реестр пуст, сами процессы это не затрагивает
  }
}

/** Атомарная запись (tmp + rename): два CLI не должны оставить полфайла. */
function writeState(entries: LabStateEntry[]): void {
  mkdirSync(labRoot(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  renameSync(tmp, statePath());
}

export function addEntry(e: LabStateEntry): void {
  writeState([...readState().filter((x) => x.id !== e.id), e]);
}

export function removeEntry(id: string): void {
  if (!existsSync(statePath())) return;
  const cur = readState();
  if (cur.some((x) => x.id === id)) writeState(cur.filter((x) => x.id !== id));
}
