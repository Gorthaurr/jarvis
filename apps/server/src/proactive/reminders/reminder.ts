/**
 * Напоминание (§9) — модель и чистая логика времени. Durable: храним АБСОЛЮТНЫЙ момент `fireAt`
 * (epoch ms), а НЕ задержку — задержка умирает при рестарте, абсолютное время переживает (см. store).
 *
 * Время вычисляет СЕРВЕР (не LLM): модель даёт намерение (delaySeconds ИЛИ at), сервер считает fireAt —
 * это убирает класс багов с арифметикой дат/таймзон у модели.
 */

export type ReminderStatus = "scheduled" | "done" | "cancelled";

/**
 * Правило повтора (волна D, 2026-07-29). Раньше напоминание было СТРОГО одноразовым, и «напоминай
 * каждый день пить таблетки» — базовый бытовой запрос к мажордому — было невозможно выразить вообще.
 * Держим МИНИМАЛЬНЫЙ набор реальных бытовых ритмов, а не полный RRULE: сложное правило владелец
 * произносит редко, а каждая лишняя степень свободы — это класс багов с датами.
 */
export type RepeatRule =
  | { kind: "daily" } // каждый день в то же локальное время
  | { kind: "weekdays" } // пн–пт (рабочие дни)
  | { kind: "weekly" } // тот же день недели
  | { kind: "interval"; seconds: number }; // каждые N секунд (напр. «каждые 3 часа»)

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
  /** Волна D: повторять по правилу. Пусто = одноразовое (прежнее поведение, ничего не меняется). */
  repeat?: RepeatRule;
  /**
   * Волна D: id СЕРИИ (равен id первого экземпляра). Каждое срабатывание порождает НОВУЮ запись, и
   * без общего ключа их нельзя ни схлопнуть (три пропущенных «таблетки» не должны прозвучать пачкой
   * при подключении), ни отличить повтор той же серии от второй параллельной серии.
   */
  seriesId?: string;
}

/** Разобрать намерение модели о повторе. Пусто → undefined (одноразовое). Ошибка — текстом для модели. */
export function parseRepeat(raw: unknown): { repeat?: RepeatRule } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "daily" || v === "каждый день" || v === "ежедневно") return { repeat: { kind: "daily" } };
    if (v === "weekdays" || v === "будни" || v === "по будням") return { repeat: { kind: "weekdays" } };
    if (v === "weekly" || v === "еженедельно" || v === "каждую неделю") return { repeat: { kind: "weekly" } };
    return { error: "repeat: допустимо daily | weekdays | weekly, либо repeat_seconds для «каждые N»." };
  }
  if (typeof raw === "number") {
    // repeat_seconds как число: «каждые N секунд». Минимум минута — чаще это будильник-спам.
    if (!Number.isFinite(raw) || raw < 60) return { error: "repeat_seconds: минимум 60 (раз в минуту)." };
    if (raw > 366 * 24 * 3600) return { error: "repeat_seconds: слишком большой интервал (максимум год)." };
    return { repeat: { kind: "interval", seconds: Math.round(raw) } };
  }
  return { error: "repeat: строка (daily|weekdays|weekly) или repeat_seconds (число секунд)." };
}

/**
 * Следующее срабатывание ПОСЛЕ `after`, строго в будущем относительно `now`. Возвращает null, если
 * правила нет (одноразовое).
 *
 * Два honest-требования:
 *  • ПРОПУЩЕННЫЕ слоты не копятся: ПК был выключен сутки → владелец получит ОДНО напоминание в
 *    ближайший будущий слот, а не десять подряд «за вчера» (для этого крутим вперёд, пока не > now);
 *  • сохраняем ЛОКАЛЬНОЕ ВРЕМЯ СУТОК: перевод часов (DST) не должен сдвигать «в 9 утра» на 8 или 10,
 *    поэтому для суточных ритмов двигаем календарную дату, а не прибавляем 24ч.
 */
export function nextFireAfter(rule: RepeatRule | undefined, after: number, now: number): number | null {
  if (!rule) return null;
  if (rule.kind === "interval") {
    const stepMs = rule.seconds * 1000;
    if (stepMs <= 0) return null;
    let next = after + stepMs;
    if (next <= now) {
      // Догоняем одним прыжком (без цикла по каждому пропущенному слоту).
      const missed = Math.ceil((now - next) / stepMs);
      next += missed * stepMs;
      if (next <= now) next += stepMs;
    }
    return next;
  }
  const stepDays = rule.kind === "weekly" ? 7 : 1;
  const d = new Date(after);
  let guard = 0;
  do {
    d.setDate(d.getDate() + stepDays); // календарный сдвиг → локальные часы/минуты сохраняются при DST
    // Будни: пропускаем субботу (6) и воскресенье (0).
    while (rule.kind === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
    guard += 1;
  } while (d.getTime() <= now && guard < 4000); // ~11 лет суточных шагов — потолок от вечного цикла
  return d.getTime();
}

/**
 * ОДИН ЛИ ЭТО СЛОТ серии (чистая функция). Нужна дедупу серий: «напоминай пить таблетки каждый день
 * в 9 УТРА» и «…в 9 ВЕЧЕРА» — это ДВЕ разные серии с одинаковым текстом и ритмом, и слепое сравнение
 * по тексту+ритму молча теряло вечернюю (ревью волны D, HIGH). Одинаковым считаем только совпадение
 * времени СУТОК (для weekly — ещё и дня недели, для interval — фазы сетки).
 */
export function sameSeriesSlot(rule: RepeatRule, a: number, b: number): boolean {
  if (rule.kind === "interval") {
    const step = rule.seconds * 1000;
    if (step <= 0) return false;
    const phase = Math.abs(a - b) % step;
    return phase < 60_000 || step - phase < 60_000; // одна и та же точка сетки (допуск минута)
  }
  const da = new Date(a);
  const db = new Date(b);
  // ДОПУСК ПО МИНУТАМ (контроль-2 волны D): точное равенство h:m делало «пересказ» серии новой серией —
  // владелец в 21:03 сказал «напоминай каждый день», через неделю в 21:07 повторил ту же просьбу, и
  // жили ДВЕ ежедневные серии с одним текстом (звонок дважды в день, add рапортует created:true).
  // Слот — это «примерно то же время суток», а не отметка секундомера; у interval допуск минуты был
  // с самого начала. Разные слоты одного дела (9:00 и 21:00, 9:00 и 9:30) допуск не склеивает.
  const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();
  const diff = Math.abs(minutesOfDay(da) - minutesOfDay(db));
  // Через полночь: 23:58 и 00:01 — соседние минуты, а не 22 часа разницы.
  const clockDiff = Math.min(diff, 24 * 60 - diff);
  if (clockDiff > SLOT_TOLERANCE_MIN) return false;
  return rule.kind === "weekly" ? da.getDay() === db.getDay() : true;
}

/** Допуск «то же время суток» для слота серии, мин. Шире — начнём склеивать соседние дела. */
const SLOT_TOLERANCE_MIN = 5;

/**
 * СРАБОТАЕТ ЛИ серия ИМЕННО В ЭТОТ МОМЕНТ (финальное ревью волны D, HIGH). `sameSeriesSlot` отвечает
 * лишь «то же время суток» и НЕ годится, чтобы решать «серия покроет это разовое, можно снять»:
 *   • weekdays: суббота 9:00 совпадает по времени с «по будням в 9:00», но серия в субботу НЕ звонит
 *     → снятое разовое пропадало молча, а хендлер рапортовал «поставлено» (ложный успех);
 *   • серия, чей ПЕРВЫЙ огонь завтра, не покрывает сегодняшний вечер (прошлое серия не обслуживает).
 * Здесь — честная проверка расписания: момент должен быть НЕ РАНЬШЕ старта серии и лежать на её сетке.
 */
export function seriesCoversMoment(rule: RepeatRule, seriesFireAt: number, moment: number): boolean {
  const tolMs = SLOT_TOLERANCE_MIN * 60_000;
  if (moment < seriesFireAt - tolMs) return false; // прошлое серия не обслуживает
  if (!sameSeriesSlot(rule, seriesFireAt, moment)) return false; // не то время суток / не та фаза
  if (rule.kind === "weekdays") {
    const d = new Date(moment).getDay();
    return d >= 1 && d <= 5; // выходные «по будням» не покрывает
  }
  return true; // daily/weekly/interval уже проверены sameSeriesSlot (у weekly там же день недели)
}

/** Человеко-описание ритма для подтверждения владельцу («каждый день», «по будням»). Чистая. */
export function describeRepeat(rule: RepeatRule | undefined): string {
  if (!rule) return "";
  switch (rule.kind) {
    case "daily":
      return "каждый день";
    case "weekdays":
      return "по будням";
    case "weekly":
      return "каждую неделю";
    case "interval": {
      const s = rule.seconds;
      if (s % 3600 === 0) return `каждые ${s / 3600} ч`;
      if (s % 60 === 0) return `каждые ${s / 60} мин`;
      return `каждые ${s} с`;
    }
  }
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

/** Значимые слова напоминания (для сравнения «про одно ли это дело»). Служебные и «напоминаю» — прочь. */
const REMINDER_STOP = new Set([
  "напоминаю", "напомнить", "напоминание", "сэр", "пожалуйста", "нужно", "надо", "чтобы", "тебе", "вам",
  "мне", "про", "для", "это", "что", "как", "она", "его", "её", "ещё",
]);
function meaningfulWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !REMINDER_STOP.has(w))
      .map((w) => w.slice(0, 6)), // грубый стем: «позвонить»/«позвони» → «позвон»
  );
}

/**
 * Об ОДНОМ ЛИ ДЕЛЕ два напоминания (чистая функция).
 *
 * Зачем: живой смоук волны D поймал дубль — рефлекс обязательств поставил «позвонить маме» на 10:00,
 * а основная петля агента, услышав ту же реплику, своё на 11:00. Точная идемпотентность (текст+время)
 * такое не ловит: формулировки и время разные, а дело ОДНО, и владелец получил бы два звонка.
 * Сравниваем по значимым словам; порог высокий, чтобы «позвонить маме» и «позвонить врачу» остались
 * разными делами.
 */
export function sameReminderSubject(a: string, b: string): boolean {
  const wa = meaningfulWords(a);
  const wb = meaningfulWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return common / Math.min(wa.size, wb.size) >= 0.7;
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
