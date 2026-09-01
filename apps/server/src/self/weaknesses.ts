/**
 * САМОДИАГНОСТИКА: «в чём я слаб» из СОБСТВЕННОЙ телеметрии (волна I, 2026-08-31).
 *
 * Джарвис уже пишет durable-факты о себе: `metrics.jsonl` (задачи, раунды, деградации, здоровье
 * процесса) и `server-YYYY-MM-DD.log` (WARN/ERROR). Но читал их ТОЛЬКО человек — сам он о своих
 * повторяющихся отказах не знал ничего, поэтому «почини себя» упиралось в память разговора, а не в
 * факты. Здесь сырые строки сворачиваются в ранжированный список слабостей.
 *
 * 🔴 Честность важнее полноты: слабость — это ПОВТОРЯЮЩИЙСЯ факт с числом и окном, а не догадка.
 * Ничего не найдено → так и говорим; логов нет → это «я не знаю», а не «всё хорошо» (та же грань,
 * что у слепой вкладки в наблюдениях и у нечитаемого календаря).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Одна слабость: что повторяется, сколько раз, с примерами. */
export interface Weakness {
  /** Машинный слаг вида `degradation:web_search_empty` / `task_failures` / `warn:...`. */
  kind: string;
  /** Человеческая формулировка для доклада владельцу. */
  title: string;
  count: number;
  /** До трёх примеров (сырые фрагменты) — чтобы не гадать по одному счётчику. */
  samples: string[];
}

export interface WeaknessReport {
  /** Окно наблюдения в днях (сколько дневных логов удалось прочитать). */
  windowDays: number;
  /**
   * Всего задач в окне; `failed` — провалы РАБОТЫ, `llmUnavailable` — ходы, не дошедшие до модели
   * (кончился ключ, протухла подписка). Смешивать их нельзя: во втором случае чинить надо доступ к
   * модели, а не себя, и «каждая шестая задача провалена» было бы наговором на собственную логику.
   */
  tasks: { total: number; failed: number; llmUnavailable: number };
  weaknesses: Weakness[];
  /** Телеметрию прочитать не удалось (нет каталога/пустые файлы) — «не знаю», не «всё хорошо». */
  unavailable?: string;
}

/** Сколько последних строк metrics.jsonl разбираем (файл ротируется по размеру, до 64 МБ). */
const MAX_METRIC_LINES = 20_000;
const MAX_LOG_BYTES = 8_000_000;

/** Прочитать хвост файла (последние `maxLines` строк) без загрузки гигантов целиком. */
async function tailLines(path: string, maxLines: number): Promise<string[]> {
  const buf = await readFile(path, "utf8").catch(() => "");
  if (!buf) return [];
  const lines = buf.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

/** Разобрать JSONL, молча пропуская битые строки (лог — не контракт, обрыв записи возможен). */
function parseJsonl(lines: readonly string[]): Record<string, unknown>[] {
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

/**
 * Свернуть метрики в слабости (ЧИСТАЯ функция — тестируется без диска).
 * `minCount` отсекает единичные случаи: слабость — то, что ПОВТОРЯЕТСЯ.
 */
export function weaknessesFromMetrics(
  events: readonly Record<string, unknown>[],
  minCount = 2,
): { weaknesses: Weakness[]; tasks: { total: number; failed: number; llmUnavailable: number } } {
  const degradations = new Map<string, { count: number; samples: string[] }>();
  let total = 0;
  let failed = 0;
  let llmUnavailable = 0;
  for (const e of events) {
    const type = String(e.type ?? "");
    if (type === "degradation") {
      const kind = String(e.kind ?? "?");
      const slot = degradations.get(kind) ?? { count: 0, samples: [] };
      slot.count += 1;
      const detail = String(e.query ?? e.domain ?? e.tool ?? e.reason ?? "");
      if (detail && slot.samples.length < 3) slot.samples.push(detail.slice(0, 160));
      degradations.set(kind, slot);
      continue;
    }
    // Событие задачи пишется без поля type (historical): опознаём по обязательным полям.
    if (!type && typeof e.ok === "boolean" && typeof e.rounds === "number") {
      total += 1;
      if (e.ok === false) {
        // Ход не дошёл до модели — это отказ КАНАЛА, а не моя работа. Старые записи (до 2026-08-31)
        // поля не имеют: там опознаём по отпечатку «0 раундов и 0 выходных токенов».
        const usage = (e.usage ?? {}) as { outputTokens?: unknown };
        const looksUnavailable = e.rounds === 0 && Number(usage.outputTokens ?? 0) === 0;
        if (e.failKind === "llm_unavailable" || (e.failKind === undefined && looksUnavailable)) llmUnavailable += 1;
        else failed += 1;
      }
    }
  }

  const weaknesses: Weakness[] = [];
  for (const [kind, slot] of degradations) {
    if (slot.count < minCount) continue;
    weaknesses.push({ kind: `degradation:${kind}`, title: degradationTitle(kind, slot.count), count: slot.count, samples: slot.samples });
  }
  // Провалы задач — слабость, только если их доля заметна: единичный провал бывает у любой системы.
  if (total >= 5 && failed / total >= 0.2) {
    weaknesses.push({
      kind: "task_failures",
      title: `Каждая ${Math.round(total / Math.max(1, failed))}-я задача завершается провалом (${failed} из ${total})`,
      count: failed,
      samples: [],
    });
  }
  // Отдельная строка: не моя логика, но владельцу знать НУЖНО — без канала я не работаю вовсе.
  if (total >= 5 && llmUnavailable / total >= 0.1) {
    weaknesses.push({
      kind: "llm_unavailable",
      title: `Ходы, не дошедшие до модели (кончился ключ или подписка): ${llmUnavailable} из ${total} — чинить надо доступ, а не меня`,
      count: llmUnavailable,
      samples: [],
    });
  }
  weaknesses.sort((a, b) => b.count - a.count);
  return { weaknesses, tasks: { total, failed, llmUnavailable } };
}

/** Понятная формулировка известных видов деградации (незнакомый вид — отдаём как есть, не выдумываем). */
function degradationTitle(kind: string, count: number): string {
  const map: Record<string, string> = {
    web_search_empty: "Поиск в вебе возвращал пустоту",
    knowledge_miss: "В базе знаний не находилось раздела под запрос",
    context_masked: "Задача упиралась в размер контекста, наблюдения приходилось сворачивать",
    autonomy_throttled: "Фоновые обращения к модели упирались в часовой предохранитель",
    calendar_unreadable: "Календарь не читался",
    calendar_chips_unparsed: "Разметку календаря не удавалось разобрать",
    mail_unreadable: "Почта не читалась",
    mail_layout_unknown: "Вёрстка почты не распознавалась",
    mail_unread_marker_unknown: "Не удавалось отличить непрочитанные письма",
  };
  return `${map[kind] ?? `Повторяющаяся деградация «${kind}»`} — ${count} раз(а)`;
}

/** Нормализация строки лога до «вида проблемы»: числа/id/пути схлопываются, иначе каждый случай уникален. */
export function normalizeLogMessage(msg: string): string {
  // Порядок важен: сперва идентификаторы, потом числа. Наоборот — «a1b2c3d4» превращается в
  // «aNbNcNdN» и перестаёт быть идентификатором, а однотипные строки не схлопываются (поймано тестом).
  return String(msg ?? "")
    .replace(/[a-f0-9]{8,}/gi, "ID")
    .replace(/\d+/g, "N")
    .trim()
    .slice(0, 120);
}

/** Свернуть WARN/ERROR серверного лога в слабости (ЧИСТАЯ функция). */
export function weaknessesFromLogs(entries: readonly Record<string, unknown>[], minCount = 3): Weakness[] {
  const buckets = new Map<string, { count: number; samples: string[]; level: string }>();
  for (const e of entries) {
    const level = String(e.level ?? "");
    if (level !== "warn" && level !== "error") continue;
    const key = `${level}:${normalizeLogMessage(String(e.msg ?? ""))}`;
    const slot = buckets.get(key) ?? { count: 0, samples: [], level };
    slot.count += 1;
    if (slot.samples.length < 3) {
      const meta = e.meta ?? e.data;
      if (meta) slot.samples.push(JSON.stringify(meta).slice(0, 160));
    }
    buckets.set(key, slot);
  }
  const out: Weakness[] = [];
  for (const [key, slot] of buckets) {
    if (slot.count < minCount) continue;
    const msg = key.slice(key.indexOf(":") + 1);
    out.push({ kind: key, title: `${slot.level === "error" ? "Ошибка" : "Предупреждение"}: «${msg}» — ${slot.count} раз(а)`, count: slot.count, samples: slot.samples });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Собрать отчёт с диска. `logsDir` — каталог durable-логов (dataDir/logs). */
export async function collectWeaknesses(logsDir: string, opts: { days?: number; limit?: number } = {}): Promise<WeaknessReport> {
  const days = Math.max(1, Math.min(Number(opts.days) || 7, 30));
  const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 40));
  let names: string[] = [];
  try {
    names = await readdir(logsDir);
  } catch {
    return { windowDays: 0, tasks: { total: 0, failed: 0, llmUnavailable: 0 }, weaknesses: [], unavailable: `каталог логов недоступен (${logsDir})` };
  }

  // 🔴 Окно обязано быть НАСТОЯЩИМ (ревью волны I): metrics.jsonl копится месяцами и ротируется по
  // размеру, а не по дням. Раньше отчёт говорил «Окно: 7 дн. Задач: 502», хотя 502 — это ВСЯ история
  // файла: заголовок утверждал то, чего не считал (закон честности — то же, что «не смог проверить»).
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const metricEvents = parseJsonl(await tailLines(join(logsDir, "metrics.jsonl"), MAX_METRIC_LINES)).filter((e) => {
    const ts = Date.parse(String(e.ts ?? ""));
    return Number.isFinite(ts) ? ts >= since : true; // строка без времени (легаси) — не выбрасываем
  });
  const dayFiles = names.filter((n) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort().slice(-days);
  const logEntries: Record<string, unknown>[] = [];
  for (const f of dayFiles) {
    const raw = await readFile(join(logsDir, f), "utf8").catch(() => "");
    logEntries.push(...parseJsonl(raw.slice(-MAX_LOG_BYTES).split(/\r?\n/).filter(Boolean)));
  }

  if (metricEvents.length === 0 && logEntries.length === 0) {
    return { windowDays: dayFiles.length, tasks: { total: 0, failed: 0, llmUnavailable: 0 }, weaknesses: [], unavailable: "телеметрия пуста — судить о слабостях не по чему" };
  }

  const fromMetrics = weaknessesFromMetrics(metricEvents);
  const fromLogs = weaknessesFromLogs(logEntries);
  const weaknesses = [...fromMetrics.weaknesses, ...fromLogs].sort((a, b) => b.count - a.count).slice(0, limit);
  return { windowDays: dayFiles.length, tasks: fromMetrics.tasks, weaknesses };
}
