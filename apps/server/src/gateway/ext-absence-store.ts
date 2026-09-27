/**
 * Durable-состояние учёта отсутствия расширения (`data/ext-presence.json`). Отдельно от логики (ext-absence.ts):
 * чтение с САНАЦИЕЙ (адверс-ревью 27.09: битый/чужой файл давал в докладе «с NaN undefined» и «около 2.7e+293 ч»)
 * и атомарная запись (tmp + rename: обрезанный файл терял флаг доклада → лишний повтор).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AbsenceKind = "chrome" | "unknown";

export interface AbsenceState {
  /** Последний раз расширение было на связи (unix ms); null — не видели с начала учёта. */
  lastSeenAt: number | null;
  /** Наблюдённое отсутствие: клиент на связи, экран не заблокирован, расширения нет (мс). */
  absentMs: number;
  /** Из него Chrome на переднем плане (мс). */
  chromeMs: number;
  /** Какой доклад уже сделан в ЭТОМ провале (гасится восстановлением связи). */
  reportedKind: AbsenceKind | null;
  /** ID расширения, которое стучалось на /ext и было отклонено пиннингом, пока нашего не было. */
  pinRejectedId: string | null;
}

export const freshAbsence = (): AbsenceState => ({ lastSeenAt: null, absentMs: 0, chromeMs: 0, reportedKind: null, pinRejectedId: null });

const YEAR_MS = 366 * 24 * 3_600_000;
const EPOCH_2020 = Date.UTC(2020, 0, 1);

function inRange(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** Прочитать и санировать; нет файла / битый → чистый учёт (fail-safe). */
export function loadAbsence(file: string, now: number): AbsenceState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const kind = raw.reportedKind === "chrome" || raw.reportedKind === "unknown" ? raw.reportedKind : null;
    const id = typeof raw.pinRejectedId === "string" && /^[a-p]{32}$/u.test(raw.pinRejectedId) ? raw.pinRejectedId : null;
    return {
      lastSeenAt: inRange(raw.lastSeenAt, EPOCH_2020, now + 24 * 3_600_000),
      absentMs: inRange(raw.absentMs, 0, YEAR_MS) ?? 0,
      chromeMs: inRange(raw.chromeMs, 0, YEAR_MS) ?? 0,
      reportedKind: kind,
      pinRejectedId: id,
    };
  } catch {
    return freshAbsence();
  }
}

/** Атомарно записать (бросает — ловит вызывающий). */
export function saveAbsence(file: string, s: AbsenceState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 2, ...s }), "utf8");
  renameSync(tmp, file);
}
