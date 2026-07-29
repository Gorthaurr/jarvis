/**
 * Durable файловый лог КЛИЕНТА (аудит 2026-07-28): половина «вчера оглох» была диагностически слепа —
 * захват аудио, VAD, wake, актуаторы и реконнекты писали только в консоль Electron, закрытую у живого
 * пользователя. Зеркало серверного `apps/server/src/obs/file-log.ts` (буфер + флаш по таймеру, ротация
 * по дню, retention), но: префикс файла `client-`, каталог — `%APPDATA%/Jarvis/logs` (app.getPath
 * ("userData")) — клиент не знает серверного JARVIS_DATA_DIR и не должен писать в cwd.
 *
 * Fail-safe: любой сбой ФС проглатывается (консоль — основной канал, файл — бонус). Формат JSONL.
 * Выключатель: JARVIS_CLIENT_FILE_LOG=0.
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { type LogSink, addLogSink, createLogger } from "@jarvis/shared";

const log = createLogger("client:file-log");

/** Потолок сериализованного meta в строке (как на сервере — крупный payload не раздувает дневной лог). */
const META_MAX_CHARS = 8192;

/** YYYY-MM-DD (локальная дата — как в именах серверных логов). */
function dayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Retention: удалить client-*.log старше retentionDays. Fail-safe. Экспорт — для юнит-теста. */
export function pruneOldClientLogs(dir: string, retentionDays: number, now: Date): void {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60_000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // папки ещё нет
  }
  for (const name of names) {
    const m = /^client-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
    if (!m) continue;
    const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (fileDay < cutoff) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* занят/удалён — не критично */
      }
    }
  }
}

/** Буферизованный файловый sink (клиентский близнец серверного FileLogSink). */
export class ClientFileLogSink {
  private buf: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentDay = "";
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly flushMs: number;

  constructor(opts: { dir?: string; retentionDays?: number; flushMs?: number } = {}) {
    this.dir = opts.dir ?? join(app.getPath("userData"), "logs");
    const rd = Number.parseInt(process.env.JARVIS_LOG_RETENTION_DAYS ?? "", 10);
    this.retentionDays = opts.retentionDays ?? (Number.isFinite(rd) && rd >= 1 && rd <= 365 ? rd : 7);
    this.flushMs = opts.flushMs ?? 1000;
    try {
      mkdirSync(this.dir, { recursive: true });
      pruneOldClientLogs(this.dir, this.retentionDays, new Date());
    } catch {
      /* нет прав/ФС — sink просто не пишет, консоль работает */
    }
  }

  /** Sink для addLogSink: в буфер, не на диск (флаш по таймеру). */
  readonly sink: LogSink = (entry) => {
    let meta: unknown = entry.meta;
    if (meta !== undefined) {
      let ser: string;
      try {
        ser = JSON.stringify(meta) ?? "undefined";
      } catch {
        ser = String(meta);
        meta = ser;
      }
      if (ser.length > META_MAX_CHARS) {
        meta = `${ser.slice(0, META_MAX_CHARS)}…[+${ser.length - META_MAX_CHARS} симв. срезано]`;
      }
    }
    const rec = { ts: new Date(entry.ts).toISOString(), level: entry.level, scope: entry.scope, msg: entry.msg, ...(meta !== undefined ? { meta } : {}) };
    this.buf.push(JSON.stringify(rec));
    if (this.buf.length >= 2000) this.flush(); // защита на спам-пиках (аудио-кадры/VAD)
  };

  /** Слить буфер на диск (ротация по дню). Fail-safe. */
  flush(): void {
    if (this.buf.length === 0) return;
    const lines = this.buf;
    this.buf = [];
    const day = dayStr(new Date());
    if (day !== this.currentDay) {
      this.currentDay = day;
      try {
        pruneOldClientLogs(this.dir, this.retentionDays, new Date());
      } catch {
        /* не критично */
      }
    }
    try {
      appendFileSync(join(this.dir, `client-${day}.log`), lines.join("\n") + "\n");
    } catch {
      /* сбой записи — порция потеряна, консоль уже отработала */
    }
  }

  /** Периодический флаш (unref — не держит процесс). Идемпотентно. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
  }

  /** Стоп + дослать остаток (graceful shutdown). */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

let active: ClientFileLogSink | null = null;

/** Поднять durable-лог клиента (звать в app.whenReady — нужен app.getPath). Идемпотентно. */
export function initClientFileLog(): void {
  if (active || (process.env.JARVIS_CLIENT_FILE_LOG ?? "1") === "0") return;
  try {
    active = new ClientFileLogSink();
    addLogSink(active.sink);
    active.start();
    log.info("durable-лог клиента включён", { dir: join(app.getPath("userData"), "logs") });
  } catch (e) {
    log.warn("durable-лог клиента не поднялся", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Дослать хвост и остановить (before-quit). */
export function disposeClientFileLog(): void {
  active?.dispose();
  active = null;
}
