/**
 * Файловый приёмник логов (наблюдаемость, аудит 2026-07-02). Проблема: сервер писал ТОЛЬКО в консоль —
 * после закрытия окна/деплоя истории не оставалось, и каждый разбор «вчера не сработало» был слеп
 * (свежих логов на диске не было вовсе). Здесь — durable лог в `dataDir/logs/server-YYYY-MM-DD.log`
 * с ротацией по дню и retention (старые дни удаляются). НЕ горячий путь: пишем БУФЕРОМ с флашем по
 * таймеру (дешевле, чем appendFileSync на каждую строку — deepgram спамит сотнями строк).
 *
 * Fail-safe: любой сбой ФС проглатывается (консоль — основной канал, файл — бонус). Формат — JSONL
 * (одна запись на строку), чтобы аудит грепал/парсил машинно, а не регэкспил человекочитаемый вывод.
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type LogSink, addLogSink, createLogger } from "@jarvis/shared";
import { dataPath } from "../paths.js";

const log = createLogger("obs:file-log");

/** Потолок длины сериализованного `meta` в одной строке лога (идея bounded-serialization, ревью
 *  learn-coding-agent 2026-07-15): крупный объект в log.info иначе раздул бы дневной лог. Свыше — режем
 *  с маркером сколько срезано. Небольшой структурный meta (частый случай) не трогаем — остаётся JSON для грепа. */
const META_MAX_CHARS = 8192;

/** Папка логов (§универсальность: JARVIS_DATA_DIR → иначе cwd/data). */
function logsDir(): string {
  return dataPath("logs");
}

/** YYYY-MM-DD из даты (локальная — как в именах файлов деплоя). */
function dayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Retention: удалить server-*.log старше retentionDays. Чистая по эффекту, fail-safe. */
export function pruneOldLogs(dir: string, retentionDays: number, now: Date): void {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60_000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // папки ещё нет — нечего чистить
  }
  for (const name of names) {
    const m = /^server-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
    if (!m) continue;
    const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (fileDay < cutoff) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* уже удалён/занят — не критично */
      }
    }
  }
}

/**
 * Буферизованный файловый sink логов. Держит очередь строк, флашит по таймеру (unref — не держит
 * event loop) и на явный flush()/dispose(). Ротация по дню (проверяется на флаше). Синглтон на процесс.
 */
export class FileLogSink {
  private buf: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentDay = "";
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly flushMs: number;

  constructor(opts: { dir?: string; retentionDays?: number; flushMs?: number } = {}) {
    this.dir = opts.dir ?? logsDir();
    const rd = Number.parseInt(process.env.JARVIS_LOG_RETENTION_DAYS ?? "", 10);
    this.retentionDays = opts.retentionDays ?? (Number.isFinite(rd) && rd >= 1 && rd <= 365 ? rd : 7);
    this.flushMs = opts.flushMs ?? 1000;
    try {
      mkdirSync(this.dir, { recursive: true });
      pruneOldLogs(this.dir, this.retentionDays, new Date());
    } catch {
      /* нет прав/ФС — sink просто не будет писать, консоль работает */
    }
  }

  /** Sink-функция для addLogSink: кладёт запись в буфер (не пишет синхронно). */
  readonly sink: LogSink = (entry) => {
    // meta может содержать несериализуемое (циклы/BigInt) — стягиваем безопасно; и КРУПНОЕ — режем по длине
    // (одна строка log.info с большим payload раздула бы дневной лог до флаша/ротации).
    let meta: unknown = entry.meta;
    if (meta !== undefined) {
      let ser: string;
      try {
        ser = JSON.stringify(meta) ?? "undefined";
      } catch {
        ser = String(meta);
        meta = ser; // несериализуемое — храним строковую форму
      }
      if (ser.length > META_MAX_CHARS) {
        meta = `${ser.slice(0, META_MAX_CHARS)}…[+${ser.length - META_MAX_CHARS} симв. срезано]`;
      }
    }
    const rec = { ts: new Date(entry.ts).toISOString(), level: entry.level, scope: entry.scope, msg: entry.msg, ...(meta !== undefined ? { meta } : {}) };
    this.buf.push(JSON.stringify(rec));
    if (this.buf.length >= 2000) this.flush(); // защита от разрастания буфера на спам-пиках
  };

  /** Записать накопленный буфер на диск (ротация по дню). Fail-safe. */
  flush(): void {
    if (this.buf.length === 0) return;
    const lines = this.buf;
    this.buf = [];
    const day = dayStr(new Date());
    if (day !== this.currentDay) {
      this.currentDay = day;
      try {
        pruneOldLogs(this.dir, this.retentionDays, new Date()); // смена суток → подчистить хвост
      } catch {
        /* не критично */
      }
    }
    try {
      appendFileSync(join(this.dir, `server-${day}.log`), lines.join("\n") + "\n");
    } catch {
      /* сбой записи — роняем эту порцию, консоль уже отработала */
    }
  }

  /** Запустить периодический флаш. Идемпотентно. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref?.();
  }

  /** Остановить таймер и дослать остаток (graceful shutdown). */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

/**
 * Поднять файловый лог на процесс: создать sink, зарегистрировать в логгере, запустить флаш.
 * Возвращает FileLogSink (для dispose в gateway.close). Env JARVIS_FILE_LOG=0 — выключить.
 */
export function initFileLog(): FileLogSink | null {
  if ((process.env.JARVIS_FILE_LOG ?? "1") === "0") return null;
  const fsink = new FileLogSink();
  addLogSink(fsink.sink);
  fsink.start();
  log.info("файловый лог включён", { dir: logsDir(), retentionDays: (process.env.JARVIS_LOG_RETENTION_DAYS ?? "7") });
  return fsink;
}
