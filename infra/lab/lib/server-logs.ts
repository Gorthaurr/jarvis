/**
 * Логи лаб-сервера: stdout/stderr процесса (server.out.log) + JSONL-лог сервера (data/logs/server-YYYY-MM-DD.log) и
 * metrics.jsonl. Читаем только хвост файла: лог за сессию мал, но JSONL-лог не должен читаться целиком при разрастании.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TAIL_BYTES = 256 * 1024;

/** Последние `lines` строк файла (читает не более TAIL_BYTES с конца). Нет файла — пусто. */
export function tailFile(path: string, lines: number): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const all = buf.toString("utf8").split(/\r?\n/u);
  if (size > len) all.shift(); // первая строка могла быть обрезана посередине
  while (all.length && all[all.length - 1] === "") all.pop();
  return all.slice(-Math.max(1, lines));
}

/** Самый свежий JSONL-лог сервера в data/logs (server-YYYY-MM-DD.log; запасные `.pid.log` тоже). */
export function latestServerLog(dataDir: string): string | undefined {
  const dir = join(dataDir, "logs");
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter((n) => /^server-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/u.test(n));
  const best = names.map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  return best ? join(dir, best.n) : undefined;
}

/** Хвост лога для человека/агента: процесс (включая падения до старта файлового лога) и JSONL сервера. */
export function composeLogTail(outLog: string, dataDir: string, lines = 60): string {
  const parts: string[] = [`=== процесс (stdout+stderr), последние ${lines} ===`, ...tailFile(outLog, lines)];
  const jsonl = latestServerLog(dataDir);
  if (jsonl) parts.push(`=== ${jsonl.split(/[\\/]/u).pop()}, последние ${lines} ===`, ...tailFile(jsonl, lines));
  return parts.join("\n");
}

/** Разобранные строки metrics.jsonl (битые строки пропускаются — файл пишется на лету, последняя может быть неполной). */
export function readMetrics(dataDir: string): Array<Record<string, unknown>> {
  const path = join(dataDir, "logs", "metrics.jsonl");
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of tailFile(path, 5000)) {
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      /* неполная строка на лету */
    }
  }
  return out;
}
