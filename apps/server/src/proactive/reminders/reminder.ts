/**
 * Напоминание (§9) — модель и чистая логика времени. Durable: храним АБСОЛЮТНЫЙ момент `fireAt`
 * (epoch ms), а НЕ задержку — задержка умирает при рестарте, абсолютное время переживает (см. store).
 *
 * Время вычисляет СЕРВЕР (не LLM): модель даёт намерение (delaySeconds ИЛИ at), сервер считает fireAt —
 * это убирает класс багов с арифметикой дат/таймзон у модели.
 */

export type ReminderStatus = "scheduled" | "done" | "cancelled";

export interface Reminder {
  id: string;
  /** Кому проговорить (id сессии-источника). */
  sessionId: string;
  userId: string;
  /** Абсолютный момент срабатывания (epoch ms, UTC). */
  fireAt: number;
  /** Что произнести голосом, когда наступит (фразу формулирует LLM при постановке). */
  text: string;
  status: ReminderStatus;
  createdAt: number;
  /** Момент, когда таймер сработал. Установлен + status="scheduled" = сработало, но НЕ доставлено
   *  (не было активной озвучки) → ждёт ближайшего подключения сессии (flushPending). */
  firedAt?: number;
}

/** Результат резолва времени: либо момент, либо человеко-понятная ошибка для модели. */
export type FireAtResult = { fireAt: number } | { error: string };

/**
 * Вычислить абсолютный момент срабатывания из намерения модели. Ровно ОДИН из delaySeconds|at.
 * delaySeconds — относительно (для «через N»), at — абсолютное ISO-8601 (для «в 9 утра»).
 */
export function resolveFireAt(
  input: { delaySeconds?: number; at?: string },
  now: number,
): FireAtResult {
  const hasDelay = input.delaySeconds !== undefined && input.delaySeconds !== null;
  const hasAt = typeof input.at === "string" && input.at.trim() !== "";
  if (hasDelay && hasAt) return { error: "Укажите либо delay_seconds, либо at — не оба." };

  if (hasDelay) {
    const d = Number(input.delaySeconds);
    if (!Number.isFinite(d) || d < 1) return { error: "delay_seconds должно быть числом ≥ 1." };
    if (d > 366 * 24 * 3600) return { error: "Слишком далеко — не больше года." };
    return { fireAt: now + Math.round(d) * 1000 };
  }
  if (hasAt) {
    const t = Date.parse(input.at!.trim());
    if (Number.isNaN(t)) return { error: "Не понял время `at` — нужен формат ISO-8601 (напр. 2026-06-18T21:30)." };
    if (t <= now) return { error: "Время `at` уже в прошлом." };
    return { fireAt: t };
  }
  return { error: "Нужно указать delay_seconds (через сколько секунд) или at (на какое время)." };
}

/** Короткое человеко-описание момента для подтверждения модели (без точной даты — секунды/минуты). */
export function describeWhen(fireAt: number, now: number): string {
  const sec = Math.max(0, Math.round((fireAt - now) / 1000));
  if (sec < 60) return `через ${sec} сек`;
  const min = Math.round(sec / 60);
  if (min < 60) return `через ${min} мин`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `через ${hr} ч`;
  return `через ${Math.round(hr / 24)} дн`;
}
