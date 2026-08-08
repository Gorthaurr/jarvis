/**
 * ТИХИЕ ЧАСЫ несрочного проактива (волна E, идея Skales «quiet hours»): календарное окно, в котором
 * НЕсрочные ambient-уведомления («вам письмо», «в Telegram непрочитанное») не озвучиваются, а ждут
 * утра. Гейтится ТОЛЬКО ambient — напоминания и watch владелец заказал ЯВНО и на конкретное время
 * («разбуди в 3») — их тихие часы не трогают; urgent-сигналы проходят всегда.
 *
 * Формат env JARVIS_QUIET_HOURS: "23-9" или "23:30-08:15" (окно может переходить через полночь).
 * Пусто/мусор → тихих часов НЕТ (деф ВЫКЛ — владелец работает по ночам, навязывать окно нельзя).
 * Начало == концу → невалидно (окно «всегда» глушило бы проактив целиком — это работа killswitch,
 * не тихих часов).
 */

export interface QuietWindow {
  /** Минуты от полуночи [0..1439]. */
  startMin: number;
  endMin: number;
}

const TIME_RE = /^(\d{1,2})(?::(\d{2}))?$/;

function parseTime(raw: string): number | null {
  const m = TIME_RE.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] !== undefined ? Number(m[2]) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Разобрать спеку окна ("23-9" / "23:30-08:15"). Пусто/мусор/вырожденное окно → null (выкл). */
export function parseQuietWindow(spec: string | undefined): QuietWindow | null {
  if (!spec || !spec.trim()) return null;
  const parts = spec.split("-");
  if (parts.length !== 2) return null;
  const startMin = parseTime(parts[0]!);
  const endMin = parseTime(parts[1]!);
  if (startMin === null || endMin === null) return null;
  if (startMin === endMin) return null; // «всегда тихо» — не наш инструмент (см. шапку)
  return { startMin, endMin };
}

/** Попадает ли момент в окно (окно через полночь: start>end → [start..24h) ∪ [0..end)). */
export function inQuietWindow(w: QuietWindow, at: Date): boolean {
  const m = at.getHours() * 60 + at.getMinutes();
  if (w.startMin < w.endMin) return m >= w.startMin && m < w.endMin;
  return m >= w.startMin || m < w.endMin;
}
