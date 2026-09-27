/**
 * Дневные durable-логи сервера для самодиагностики (`weaknesses.ts`). р1 ревью C4/B5 (27.09): основной файл дня
 * занят чужим процессом → durable-лог пишет в запасной `server-<день>.<pid>.log`, и ВСЕ WARN/ERROR тех часов (и
 * предупреждения самого durable-лога) лежат только там. Самодиагностика читала лишь `server-<день>.log` и молчала
 * «не за что зацепиться» — сигнал честности не доходил до самообучения (закон 1). Теперь день = все его файлы:
 * окно — последние N ДНЕЙ (не файлов: запасные не вытесняют настоящие дни и не раздувают windowDays), записи дня
 * из всех его файлов сливаются по ts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** `server-YYYY-MM-DD.log` и запасные `server-YYYY-MM-DD.<pid>.log`; группа 1 — день. */
const DAY_FILE = /^server-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/;

/** Разобрать JSONL, молча пропуская битые строки (лог — не контракт, обрыв записи возможен). */
export function parseJsonl(lines: readonly string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object") out.push(o as Record<string, unknown>);
    } catch {
      /* битая строка — пропускаем */
    }
  }
  return out;
}

/** Время записи для слияния; без разборного ts — 0 (сортировка стабильна, порядок файла сохраняется). */
function tsOf(e: Record<string, unknown>): number {
  const t = Date.parse(String(e.ts ?? ""));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Прочитать последние `days` дней из `names` (листинг каталога). Каждый файл — не больше `maxBytes` с хвоста.
 * Возвращает число дней в окне и записи всех дней по порядку (внутри дня — по ts).
 */
export async function readDayLogs(
  logsDir: string,
  names: readonly string[],
  days: number,
  maxBytes: number,
): Promise<{ days: number; entries: Record<string, unknown>[] }> {
  const byDay = new Map<string, string[]>();
  for (const n of names) {
    const day = DAY_FILE.exec(n)?.[1];
    if (day) byDay.set(day, [...(byDay.get(day) ?? []), n]);
  }
  const window = [...byDay.keys()].sort().slice(-days);
  let entries: Record<string, unknown>[] = [];
  for (const day of window) {
    let dayEntries: Record<string, unknown>[] = []; // concat, не push(...): десятки тысяч аргументов — переполнение стека
    for (const f of (byDay.get(day) ?? []).sort()) {
      const raw = await readFile(join(logsDir, f), "utf8").catch(() => "");
      dayEntries = dayEntries.concat(parseJsonl(raw.slice(-maxBytes).split(/\r?\n/).filter(Boolean)));
    }
    entries = entries.concat(dayEntries.sort((a, b) => tsOf(a) - tsOf(b)));
  }
  return { days: window.length, entries };
}
