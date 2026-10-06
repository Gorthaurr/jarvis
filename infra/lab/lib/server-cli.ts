/**
 * Команды CLI, управляющие лаб-серверами: up / down / status / log / metrics (+ разбор аргументов и выбор сервера).
 * Реестр между вызовами — server-state.ts. Каждая команда возвращает JSON-совместимый результат, печатает lab.ts.
 */
import { randomUUID } from "node:crypto";
import { attachLabServer, startLabServer } from "./server.js";
import { addEntry, readState, removeEntry, type LabStateEntry } from "./server-state.js";
import { removeRunDir } from "./server-dir.js";

export interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["wait-tasks", "fresh", "keep"]);

/** `--name value` | `--name` (булевы) | позиционные. Без внешних зависимостей. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { pos: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) out.pos.push(a);
    else if (BOOLEAN_FLAGS.has(a.slice(2))) out.flags[a.slice(2)] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`флагу ${a} нужно значение`);
      out.flags[a.slice(2)] = v;
      i += 1;
    }
  }
  return out;
}

export const flag = (a: Args, name: string): string | undefined => (typeof a.flags[name] === "string" ? (a.flags[name] as string) : undefined);

/** Выбрать сервер из реестра: по id, иначе единственный. Несколько без id — ошибка со списком (не гадаем). */
export function pickEntry(id?: string): LabStateEntry {
  const all = readState();
  if (id) {
    const e = all.find((x) => x.id === id);
    if (!e) throw new Error(`сервер «${id}» не найден в реестре (lab.ts status)`);
    return e;
  }
  if (all.length === 1) return all[0] as LabStateEntry;
  throw new Error(all.length ? `серверов несколько (${all.map((x) => x.id).join(", ")}) — укажи --server <id>` : "лаб-сервер не запущен (lab.ts up)");
}

export async function cmdUp(a: Args): Promise<unknown> {
  const brain = (flag(a, "brain") ?? "off") as "off" | "real" | "scripted";
  const stt = (flag(a, "stt") ?? "mock") as "mock" | "deepgram";
  if (!["off", "real", "scripted"].includes(brain) || !["mock", "deepgram"].includes(stt)) throw new Error("--brain off|real, --stt mock|deepgram");
  if (brain === "real") process.stderr.write("[lab] brain=real: ходы идут по подписке владельца и тратят общий лимит\n");
  const port = flag(a, "port");
  const s = await startLabServer({ brain, stt, detach: true, keepDir: true, ...(port ? { port: Number(port) } : {}) });
  addEntry({ id: s.id, port: s.port, dir: s.dir, dataDir: s.dataDir, pid: s.pid, devToken: s.devToken, brain, stt, clientToken: randomUUID(), startedAt: new Date().toISOString() });
  return { id: s.id, port: s.port, dir: s.dir, pid: s.pid, token: s.devToken };
}

export async function cmdDown(a: Args): Promise<unknown> {
  const target = a.pos[0];
  const all = readState();
  const list = target === "all" ? all : target ? [pickEntry(target)] : [pickEntry()];
  const res: Array<{ id: string; stopped: boolean; note?: string }> = [];
  for (const e of list) {
    try {
      await attachLabServer(e).stop({ keepDir: a.flags.keep === true });
      res.push({ id: e.id, stopped: true });
    } catch (err) {
      res.push({ id: e.id, stopped: false, note: err instanceof Error ? err.message : String(err) });
    }
    // Процесса нет (упал / перезагрузка) — запись и каталог не должны висеть вечно.
    if (!attachLabServer(e).alive()) {
      removeEntry(e.id);
      if (a.flags.keep !== true) await removeRunDir(e.dir);
    }
  }
  return res;
}

export async function cmdStatus(): Promise<unknown> {
  return Promise.all(
    readState().map(async (e) => {
      const s = attachLabServer(e);
      return { id: e.id, port: e.port, pid: e.pid, alive: s.alive(), brain: e.brain, stt: e.stt, dir: e.dir, health: await s.health(), startedAt: e.startedAt };
    }),
  );
}

export function cmdLog(a: Args): string {
  const n = Number(a.pos[0] ?? "60");
  return attachLabServer(pickEntry(flag(a, "server"))).logTail(Number.isFinite(n) && n > 0 ? n : 60);
}

export function cmdMetrics(a: Args): unknown {
  return attachLabServer(pickEntry(flag(a, "server"))).metrics();
}
