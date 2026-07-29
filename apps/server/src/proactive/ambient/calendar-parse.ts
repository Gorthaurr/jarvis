/**
 * ЧИСТЫЙ разбор чипов календаря (волна D, D-4) — сердце «встречи через 20 минут» БЕЗ OAuth.
 *
 * Почему так: владелец отказался от любых регистраций/токенов, поэтому единственный честный источник
 * календаря — УЖЕ ЗАЛОГИНЕННАЯ вкладка (Google/Яндекс/Outlook) и её DOM. Расширение отдаёт сырые
 * aria-label чипов («Созвон с командой, 15:00 – 16:00, 29 июля 2026 г.»), а разбор живёт ЗДЕСЬ —
 * чистой функцией, которую можно проверить юнит-тестами без Chrome.
 *
 * ЗАКОН ЧЕСТНОСТИ: чип, из которого НЕ удалось достоверно вытащить момент времени, НЕ превращается
 * в событие «на сегодня наугад» — он попадает в `unparsed`. Вызывающий обязан отличать «встреч нет»
 * от «не смог прочитать» (та же грабля, что с выгруженной вкладкой в watch).
 */

/** Сырой чип из расширения (DOM-снимок вкладки календаря). */
export interface CalendarChip {
  /** aria-label/текст чипа события. */
  label: string;
  /** Подпись дня-контейнера (если разметка её дала) — запасной источник даты. */
  day?: string;
  /** Чип лежит в колонке «сегодня» (aria-current="date" и т.п.). */
  today?: boolean;
}

/** Разобранное событие календаря. */
export interface CalendarEvent {
  title: string;
  /** Абсолютный момент начала (локальная зона машины владельца). */
  startAt: number;
  /** Событие «на весь день» — времени начала в разметке не было, взяли полночь. */
  allDay: boolean;
}

export interface ParsedCalendar {
  events: CalendarEvent[];
  /** Чипы, из которых момент НЕ извлечён (метрика деградации, а не тишина). */
  unparsed: number;
}

/**
 * Месяцы — ЦЕЛЫМИ СЛОВАМИ, а не префиксом (финальное ревью волны D, HIGH: префиксный матч по любому
 * слову метки превращал «Q3 Marketing» в 3 МАРТА, «Sprint 5 decisions» — в 5 декабря, «Разбор 9
 * Майоров» — в 9 мая; дата уезжала на месяцы, а `unparsed` оставался нулевым, поэтому и деградация
 * молчала. Уверенно неверная дата хуже отсутствия даты — это прямой ложный факт владельцу).
 * Перечислены РЕАЛЬНЫЕ словоформы (родительный для «29 июля», именительный для «Июль 2026»).
 */
const RU_MONTH_RE = [
  /^январ[ья]$/u, /^феврал[ья]$/u, /^март[а]?$/u, /^апрел[ья]$/u, /^ма[йя]$/u, /^июн[ья]$/u,
  /^июл[ья]$/u, /^август[а]?$/u, /^сентябр[ья]$/u, /^октябр[ья]$/u, /^ноябр[ья]$/u, /^декабр[ья]$/u,
];
const EN_MONTH_RE = [
  /^jan(uary)?$/i, /^feb(ruary)?$/i, /^mar(ch)?$/i, /^apr(il)?$/i, /^may$/i, /^jun(e)?$/i,
  /^jul(y)?$/i, /^aug(ust)?$/i, /^sep(t|tember)?$/i, /^oct(ober)?$/i, /^nov(ember)?$/i, /^dec(ember)?$/i,
];

/** Месяц по названию (RU/EN, ЦЕЛЫМ словом) → 0..11, либо null. */
function monthFromName(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\.$/, "");
  for (let i = 0; i < RU_MONTH_RE.length; i += 1) if (RU_MONTH_RE[i]!.test(s)) return i;
  for (let i = 0; i < EN_MONTH_RE.length; i += 1) if (EN_MONTH_RE[i]!.test(s)) return i;
  return null;
}

/** Время суток из строки: «15:00», «3:00 pm», «9 am». Первое вхождение. null — времени нет. */
export function extractTimeOfDay(s: string): { h: number; m: number; start: number; end: number } | null {
  // 1) HH:MM (+ опц. am/pm) — самый частый вид в обоих языках.
  const hm = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)?/i.exec(s);
  if (hm) {
    let h = Number(hm[1]);
    const m = Number(hm[2]);
    let mer = (hm[3] ?? "").toLowerCase().replace(/\./g, "");
    const end = hm.index + hm[0].length;
    // Английский Google пишет меридием ОДИН раз — у конца диапазона: «3:00 – 4:00pm» это 15:00, а не
    // 3 утра. Наследуем меридием от конца, но только если он не делает начало ПОЗЖЕ конца
    // («11:00 – 1:00pm» → 11 утра, не 23:00).
    if (!mer) {
      const tail = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)/i.exec(s.slice(end));
      if (tail) {
        const tm = tail[3]!.toLowerCase().replace(/\./g, "");
        let endH = Number(tail[1]);
        if (tm.startsWith("p") && endH < 12) endH += 12;
        if (tm.startsWith("a") && endH === 12) endH = 0;
        const shifted = tm.startsWith("p") && h < 12 ? h + 12 : tm.startsWith("a") && h === 12 ? 0 : h;
        if (shifted <= endH) mer = tm;
      }
    }
    if (mer.startsWith("p") && h < 12) h += 12;
    if (mer.startsWith("a") && h === 12) h = 0;
    if (h <= 23 && m <= 59) return { h, m, start: hm.index, end };
  }
  // 2а) КОМПАКТНЫЙ ДИАПАЗОН без минут: «9 – 10am», «12 – 1pm». Финальное ревью (MEDIUM): без этой ветки
  // ниже подхватывался КОНЕЦ диапазона («10am») и озвучивался как НАЧАЛО встречи — владелец получал
  // предупреждение к 10:00 о том, что началось в 9:00. Меридием наследуется от конца по тому же правилу,
  // что и у HH:MM (если не переворачивает диапазон).
  const range = /(\d{1,2})\s*[–—−-]\s*(\d{1,2})\s*(a\.?m\.?|p\.?m\.?|am|pm)/i.exec(s);
  if (range) {
    const mer = range[3]!.toLowerCase().replace(/\./g, "");
    let h = Number(range[1]);
    let endH = Number(range[2]);
    if (mer.startsWith("p") && endH < 12) endH += 12;
    if (mer.startsWith("a") && endH === 12) endH = 0;
    const shifted = mer.startsWith("p") && h < 12 ? h + 12 : mer.startsWith("a") && h === 12 ? 0 : h;
    if (shifted <= endH) h = shifted;
    if (h <= 23) return { h, m: 0, start: range.index, end: range.index + String(range[1]).length };
  }
  // 2б) «3pm» / «9 am» — только с меридиемом (голое число временем НЕ считаем: «Совет 5» ≠ 5 часов).
  const hOnly = /(\d{1,2})\s*(a\.?m\.?|p\.?m\.?|am|pm)/i.exec(s);
  if (hOnly) {
    let h = Number(hOnly[1]);
    const mer = hOnly[2]!.toLowerCase().replace(/\./g, "");
    if (mer.startsWith("p") && h < 12) h += 12;
    if (mer.startsWith("a") && h === 12) h = 0;
    if (h <= 23) return { h, m: 0, start: hOnly.index, end: hOnly.index + hOnly[0].length };
  }
  return null;
}

/**
 * Дата (день+месяц, год опционально): «29 июля 2026 г.», «July 29, 2026», «2026-07-29», «29.07».
 * Перебираются ВСЕ совпадения, а не первое: «Q1 итоги, …, 29 июля 2026 г.» раньше упиралось в «1 итоги»
 * (месяц не распознан) и больше не пробовало, после чего вторая регулярка выкусывала день из ГОДА
 * («июля 20» из «июля 2026») — встреча уезжала на 9 дней БЕЗ единого признака сбоя.
 */
export function extractDate(s: string): { day: number; month: number; year?: number } | null {
  const out = (day: number, month: number, year?: number) =>
    day >= 1 && day <= 31 ? { day, month, ...(year === undefined ? {} : { year }) } : null;
  // ISO «2026-07-29» (так отдаёт data-date контейнера дня — самый надёжный источник).
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const mon = Number(iso[2]) - 1;
    if (mon >= 0 && mon <= 11) {
      const r = out(Number(iso[3]), mon, Number(iso[1]));
      if (r) return r;
    }
  }
  // «29 июля [2026]» / «29 July [2026]». (?!\d) не даёт взять день из первых цифр года.
  for (const m of s.matchAll(/(\d{1,2})(?!\d)\s+([А-Яа-яЁёA-Za-z.]{3,})(?:\s+(\d{4})(?!\d))?/gu)) {
    const mon = monthFromName(m[2]!);
    if (mon === null) continue;
    const r = out(Number(m[1]), mon, m[3] ? Number(m[3]) : undefined);
    if (r) return r;
  }
  // «July 29[, 2026]» / «Jul 29».
  for (const m of s.matchAll(/([А-Яа-яЁёA-Za-z.]{3,})\s+(\d{1,2})(?!\d)(?:,?\s*(\d{4})(?!\d))?/gu)) {
    const mon = monthFromName(m[1]!);
    if (mon === null) continue;
    const r = out(Number(m[2]), mon, m[3] ? Number(m[3]) : undefined);
    if (r) return r;
  }
  // «29.07.2026» / «29/07/26» — ОБЯЗАТЕЛЬНО С ГОДОМ (контроль-4, HIGH). Без года эта ветка выкусывала
  // дату из НОМЕРА ВЕРСИИ и десятичных чисел в названии: «Демо v1.2» → 1 февраля, «Оплата 3.5 тыс» →
  // 3 мая, «Release 2.1 review» → 2 января, причём `unparsed` оставался 0 и деградация молчала — то же
  // семейство, что «Q3 Marketing → 3 марта». Год делает совпадение однозначным; безгодовые формы дат
  // в реальных календарях приходят словами («29 июля») либо ISO из data-date контейнера.
  const dm = /(?<![\d.,])(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?![\d.])/.exec(s);
  if (dm) {
    const mon = Number(dm[2]) - 1;
    if (mon >= 0 && mon <= 11) {
      const y = Number(dm[3]);
      const r = out(Number(dm[1]), mon, y < 100 ? 2000 + y : y);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Год, если разметка его не назвала: берём ближайший к `now` вариант (прошлый/текущий/следующий).
 * Календарь показывает окрестность сегодня, поэтому «29 июля» в декабре — это СЛЕДУЮЩИЙ июль.
 */
function pickYear(day: number, month: number, h: number, min: number, now: number): number {
  const base = new Date(now).getFullYear();
  let best = base;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const y of [base - 1, base, base + 1]) {
    const d = new Date(y, month, day, h, min, 0, 0);
    if (d.getMonth() !== month) continue; // 31 февраля и т.п. — невалидная дата
    const dist = Math.abs(d.getTime() - now);
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

/** Заголовок события: часть метки до времени/даты, очищенная от хвостов. */
export function extractTitle(label: string): string {
  // Google кладёт «Название, 15:00 – 16:00, 29 июля 2026 г.» → берём до первой запятой,
  // ЕСЛИ дальше действительно идёт время (иначе запятая — часть названия).
  const comma = label.indexOf(",");
  if (comma > 0) {
    const head = label.slice(0, comma).trim();
    const tail = label.slice(comma + 1);
    if (head && extractTimeOfDay(tail)) return head.slice(0, 80);
  }
  const t = extractTimeOfDay(label);
  if (t) {
    // Название — то, что ПЕРЕД временем («Стендап команды 10:00 – 10:15» → «Стендап команды»).
    // Контроль-4 (MEDIUM): прежний срез «всё до конца времени, если оно в первых 24 символах» на
    // коротком названии выкусывал ХВОСТ диапазона и делал названием «10:15»/«16:00»/«10am» — владелец
    // слышал время вместо дела, а ключ дедупа `startAt|title` схлопывал РАЗНЫЕ встречи в одну молча.
    const head = label.slice(0, t.start).replace(/^[\s,–—-]+/, "").replace(/[\s,–—-]+$/, "");
    if (head) return head.slice(0, 80);
    // Время в самом начале («15:00 Созвон») → название после него. ВАЖНО срезать ВЕСЬ диапазон, а не
    // первое время (контроль-5): иначе «10:00 – 11:00 Ретро» давало название «11:00 Ретро», и владелец
    // слышал ДВА времени одной встречи («через 20 мин — 11:00 Ретро (в 10:00)»).
    let tail = label.slice(t.end);
    for (let i = 0; i < 2; i += 1) {
      const stripped = tail.replace(/^[\s,–—−-]+/, "");
      const next = extractTimeOfDay(stripped);
      if (!next || next.start !== 0) break; // дальше уже название, а не хвост диапазона
      tail = stripped.slice(next.end);
    }
    tail = tail.replace(/^[\s,–—−-]+/, "").replace(/[\s,]+$/, "");
    if (tail) return tail.slice(0, 80);
  }
  return label.replace(/^[\s,–—-]+/, "").replace(/[\s,]+$/, "").slice(0, 80) || label.slice(0, 80);
}

/**
 * Разобрать чипы в события. `now` — «сейчас» (для дефолта года и флага today).
 * Момент берём в ЛОКАЛЬНОЙ зоне машины (сервер = ПК владельца — так же считают напоминания).
 */
export function parseCalendarChips(chips: readonly CalendarChip[], now: number): ParsedCalendar {
  const events: CalendarEvent[] = [];
  let unparsed = 0;
  const seen = new Set<string>();
  for (const chip of chips) {
    const label = (chip.label || "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    const time = extractTimeOfDay(label);
    // Дату ищем в метке, затем в подписи дня-контейнера. Время в подписи дня нас не интересует.
    const date = extractDate(label) ?? (chip.day ? extractDate(chip.day) : null);
    let startAt: number;
    let allDay = false;
    if (date) {
      const h = time?.h ?? 0;
      const mi = time?.m ?? 0;
      allDay = !time;
      const year = date.year ?? pickYear(date.day, date.month, h, mi, now);
      const d = new Date(year, date.month, date.day, h, mi, 0, 0);
      if (d.getMonth() !== date.month) {
        unparsed += 1; // «31 июня» — разметка соврала, не выдумываем момент
        continue;
      }
      startAt = d.getTime();
    } else if (chip.today && time) {
      // Даты в метке нет, но чип лежит в колонке «сегодня» — это достоверный день.
      const n = new Date(now);
      startAt = new Date(n.getFullYear(), n.getMonth(), n.getDate(), time.h, time.m, 0, 0).getTime();
    } else {
      unparsed += 1; // ни даты, ни доказанного «сегодня» → МОЛЧА не приписываем событие к сегодня
      continue;
    }
    const title = extractTitle(label);
    const key = `${startAt}|${title.toLowerCase()}`;
    if (seen.has(key)) continue; // один чип в неделе и в списке — одно событие
    seen.add(key);
    events.push({ title, startAt, allDay });
  }
  events.sort((a, b) => a.startAt - b.startAt);
  return { events, unparsed };
}

/** События, которые ещё впереди и попадают в окно [now, now+withinMs]. */
export function upcomingEvents(events: readonly CalendarEvent[], now: number, withinMs: number): CalendarEvent[] {
  return events.filter((e) => e.startAt >= now && e.startAt <= now + withinMs);
}
