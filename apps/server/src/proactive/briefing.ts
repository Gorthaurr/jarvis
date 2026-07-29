/**
 * УТРЕННИЙ БРИФИНГ (волна D «мажордом», 2026-07-29).
 *
 * Раньше первый контакт за день давал ОДНУ фразу приветствия — Джарвис ничего не сообщал о дне,
 * хотя данные у него уже были: напоминания на сегодня, счета с наступающим сроком, активные
 * наблюдения. Владелец узнавал о деле только в момент, когда оно само заговорит.
 *
 * Здесь — ЧИСТАЯ сборка сводки из уже существующих сторов (без LLM: фактическая справка не должна
 * ни стоить денег, ни выдумывать). Принципы:
 *  • ЧЕСТНО: пусто — значит молчим (никаких «сегодня всё спокойно, сэр» ради красоты);
 *  • КОРОТКО: голос — узкий канал, поэтому 3–4 пункта максимум, остальное «и ещё N»;
 *  • РАЗ В ДЕНЬ: календарный гейт (первый контакт суток), не на каждый коннект.
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("briefing");

/** Что нужно брифингу — минимальные проекции сторов (инъекция, без глобального состояния). */
export interface BriefingInput {
  /** Активные напоминания владельца: когда и о чём. */
  reminders: ReadonlyArray<{ fireAt: number; text: string }>;
  /** Обязательства/счета: срок и о чём. */
  obligations: ReadonlyArray<{ dueAt: number; title: string }>;
  /** Активные наблюдения («следи за …»). */
  watches: ReadonlyArray<{ what: string }>;
  /** D-4: встречи из календаря владельца (уже открытая вкладка). Пусто — если календарь не прочитан. */
  events?: ReadonlyArray<{ startAt: number; title: string; allDay?: boolean }>;
}

/** Максимум пунктов в озвучке — дальше «и ещё N» (голос не терпит списков). */
const MAX_ITEMS = 3;

const hhmm = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Тот же ли календарный день (локально). */
export function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Собрать сводку дня. Возвращает null, если сообщать НЕЧЕГО — это штатный и частый исход
 * (молчание честнее пустой вежливости). Чистая функция: тестируется без сторов и сети.
 */
export function buildBriefing(input: BriefingInput, now: number): string | null {
  const dayEnd = (() => {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  })();

  // Только СЕГОДНЯШНЕЕ и ещё не наступившее — «что впереди», а не журнал.
  const todayReminders = input.reminders
    .filter((r) => r.fireAt > now && r.fireAt <= dayEnd)
    .sort((a, b) => a.fireAt - b.fireAt);
  // Счета: сегодня, завтра — и ПРОСРОЧЕННОЕ (его нельзя молча прятать, но и называть «завтра» нельзя).
  // Глубже недели назад не тянем: это уже не сводка дня, а археология.
  const overdueFloor = now - 7 * 24 * 3600_000;
  const soonObligations = input.obligations
    .filter((o) => o.dueAt >= overdueFloor && o.dueAt <= dayEnd + 24 * 3600_000)
    .sort((a, b) => a.dueAt - b.dueAt);

  // D-4: встречи СЕГОДНЯ. Идут ПЕРВЫМИ — это самое жёсткое обязательство дня (в отличие от
  // напоминания встречу нельзя сдвинуть на потом). Прошедшие не тянем, «весь день» показываем без часов.
  const todayEvents = (input.events ?? [])
    .filter((e) => e.startAt <= dayEnd && (e.allDay ? sameLocalDay(e.startAt, now) : e.startAt > now))
    .sort((a, b) => a.startAt - b.startAt);

  const parts: string[] = [];
  if (todayEvents.length > 0) {
    const shown = todayEvents
      .slice(0, MAX_ITEMS)
      .map((e) => (e.allDay ? `весь день — ${e.title}` : `в ${hhmm(e.startAt)} — ${e.title}`));
    const rest = todayEvents.length - shown.length;
    parts.push(`Встречи: ${shown.join("; ")}${rest > 0 ? `; и ещё ${rest}` : ""}`);
  }
  if (todayReminders.length > 0) {
    const shown = todayReminders.slice(0, MAX_ITEMS).map((r) => `в ${hhmm(r.fireAt)} — ${r.text}`);
    const rest = todayReminders.length - shown.length;
    parts.push(`На сегодня: ${shown.join("; ")}${rest > 0 ? `; и ещё ${rest}` : ""}`);
  }
  if (soonObligations.length > 0) {
    const shown = soonObligations.slice(0, MAX_ITEMS).map((o) => {
      // ЧЕСТНАЯ метка (ревью волны D, HIGH): бинарное «сегодня/завтра» называло ПРОСРОЧЕННОЕ «завтра»
      // — прямая ложь, повторявшаяся каждый день. Три состояния: просрочено / сегодня / завтра.
      const when = sameLocalDay(o.dueAt, now) ? "сегодня" : o.dueAt < now ? "срок уже прошёл" : "завтра";
      return `${o.title} — ${when}`;
    });
    const rest = soonObligations.length - shown.length;
    parts.push(`Сроки: ${shown.join("; ")}${rest > 0 ? `; и ещё ${rest}` : ""}`);
  }
  if (input.watches.length > 0) {
    const first = input.watches[0]!.what;
    parts.push(
      input.watches.length === 1
        ? `Слежу за: ${first}`
        : `Слежу за ${input.watches.length} вещами, в том числе: ${first}`,
    );
  }
  if (parts.length === 0) return null; // сообщать нечего — молчим
  return `Коротко по дню, сэр. ${parts.join(". ")}.`;
}

/** Состояние гейта «раз в день» (в профиле хранится время последнего брифинга). */
export interface BriefingGate {
  lastBriefedAt?: number;
}

/** Пора ли брифинговать: первый контакт нового календарного дня. Чистая. */
export function shouldBrief(gate: BriefingGate, now: number): boolean {
  if (process.env.JARVIS_BRIEFING === "0") return false;
  if (!gate.lastBriefedAt) return true;
  return !sameLocalDay(gate.lastBriefedAt, now);
}

/** Лог-хелпер (чтобы вызывающий не дублировал формулировку). */
export function logBriefing(count: number): void {
  log.info("утренний брифинг собран", { пунктов: count });
}
