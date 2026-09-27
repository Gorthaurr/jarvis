/**
 * Дневные durable-логи сервера для самодиагностики (`weaknesses.ts`). р1 ревью C4/B5 (27.09): основной файл дня
 * занят чужим процессом → durable-лог пишет в запасной `server-<день>.<pid>.log`, и ВСЕ WARN/ERROR тех часов (и
 * предупреждения самого durable-лога) лежат только там. Самодиагностика читала лишь `server-<день>.log` и молчала
 * «не за что зацепиться» — сигнал честности не доходил до самообучения (закон 1). Теперь день = все его файлы:
 * окно — последние N ДНЕЙ (не файлов: запасные не вытесняют настоящие дни и не раздувают windowDays), записи дня
 * из всех его файлов (свежих — в пределах бюджета дня, р2) сливаются по ts.
 */
import { readFile, stat } from "node:fs/promises";
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

/** Слить записи дня по ts: время каждой записи разбирается ОДИН раз, компаратор сравнивает числа (р2). */
function byTs(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries
    .map((e) => [tsOf(e), e] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => e);
}

/**
 * Записи одного дня. Бюджет `maxBytes` (в символах, как и был) — на ДЕНЬ, не на файл (р2): крэш-луп при занятом
 * основном плодит десятки `server-<день>.<pid>.log`, и потолок на файл давал проход без верхней границы. Файлы — от
 * новых к старым по mtime (имя не годится: `.4242.log` по имени раньше основного `.log`), с каждого — хвост в пределах
 * остатка; бюджет кончился — старые файлы не читаем вовсе. Прочитан один файл — его порядок и есть порядок записи,
 * без сортировки.
 */
async function readDay(logsDir: string, files: readonly string[], maxBytes: number): Promise<Record<string, unknown>[]> {
  const aged = await Promise.all(files.map(async (f) => ({ f, mtime: await stat(join(logsDir, f)).then((s) => s.mtimeMs, () => 0) })));
  aged.sort((a, b) => b.mtime - a.mtime || (a.f < b.f ? 1 : -1));
  const chunks: Record<string, unknown>[][] = [];
  let left = maxBytes;
  for (const { f } of aged) {
    if (left <= 0) break;
    const raw = (await readFile(join(logsDir, f), "utf8").catch(() => "")).slice(-left);
    left -= raw.length;
    chunks.push(parseJsonl(raw.split(/\r?\n/).filter(Boolean)));
  }
  // Старые файлы — раньше (стабильная сортировка держит их порядок для записей без ts); flat, не push(...): десятки
  // тысяч аргументов — переполнение стека.
  const all = chunks.reverse().flat();
  return chunks.length > 1 ? byTs(all) : all;
}

/**
 * Прочитать последние `days` дней из `names` (листинг каталога). На день — не больше `maxBytes` символов (свежих).
 * Возвращает число дней в окне и записи всех дней по порядку (внутри дня из нескольких файлов — по ts).
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
  for (const day of window) entries = entries.concat(await readDay(logsDir, byDay.get(day) ?? [], maxBytes));
  return { days: window.length, entries };
}
