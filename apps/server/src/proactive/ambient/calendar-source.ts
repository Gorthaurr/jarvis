/**
 * Источник ambient #3: КАЛЕНДАРЬ (волна D, D-4 — «Сэр, через 20 минут созвон»).
 *
 * БЕЗ OAuth и без единой регистрации (условие владельца): читаем УЖЕ ОТКРЫТУЮ вкладку календаря
 * (Google/Яндекс/Outlook) через расширение — в его сессии, на его логине. Нет вкладки → МОЛЧИМ и не
 * лезем (ambient не должен открывать окна и красть фокус каждые полторы минуты — ровно как
 * telegram-source). Дёшево: DOM-снимок + чистый разбор, без LLM.
 *
 * ЧЕСТНОСТЬ: «встреч нет» и «не смог прочитать» — РАЗНЫЕ исходы. Пустая (выгруженная Chrome) вкладка
 * и нераспознанная разметка не выдают тишину за спокойный день: они пишут durable-деградацию
 * (`calendar_unreadable`/`calendar_chips_unparsed`), чтобы «почему не предупредил» разбиралось по логу,
 * а не по догадкам. Та же грабля, что закрывали в watch с blank-page.
 */
import { type Logger, createLogger, envInt } from "@jarvis/shared";
import { metrics } from "../../obs/metrics.js";
import { type CalendarEvent, parseCalendarChips, upcomingEvents } from "./calendar-parse.js";
import type { AmbientSignal, AmbientSource } from "./signal.js";

const log: Logger = createLogger("ambient:calendar");

/** Ответ расширения на calendar.read. */
export interface CalendarReadResult {
  ok?: boolean;
  /** Открытой вкладки календаря нет — неинвазивный no-op (НЕ «встреч нет»). */
  noTab?: boolean;
  /** Вкладка выгружена/пуста — прочитать не смогли (НЕ «встреч нет»). */
  blank?: boolean;
  events?: Array<{ label: string; day?: string; today?: boolean }>;
  /** Сырой текст страницы — запасной канал для МОДЕЛИ (инструмент calendar_read), не для ambient. */
  text?: string;
  host?: string;
  error?: string;
}

/** Минимальный контракт ридера (ExtensionBridge реализует; в тестах — мок). */
export interface CalendarReader {
  calendarRead(): Promise<unknown>;
}

export interface CalendarSourceOpts {
  now?: () => number;
  enabled?: () => boolean;
  /** За сколько до начала предупреждать. Деф 20 мин (env JARVIS_CALENDAR_LEAD_MS). */
  leadMs?: number;
}

/** Срок годности УЖЕ СФОРМУЛИРОВАННОЙ фразы «через N мин»: дальше её надо пересобирать, а не зачитывать. */
const PHRASE_TTL_MS = 90_000;

/** Человеческое «через сколько» для фразы дворецкого. */
export function inMinutesPhrase(startAt: number, now: number): string {
  const mins = Math.max(0, Math.round((startAt - now) / 60_000));
  if (mins <= 1) return "прямо сейчас";
  if (mins < 60) return `через ${mins} мин`;
  const h = Math.round(mins / 60);
  return `через ${h} ч`;
}

/** Чистая функция: событие → ambient-сигнал. Ключ по моменту+названию — одно событие озвучивается однажды. */
export function eventSignal(ev: CalendarEvent, userId: string, now: number): AmbientSignal {
  const when = new Date(ev.startAt);
  const hhmm = `${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")}`;
  return {
    sourceId: "calendar",
    userId,
    key: `${ev.startAt}|${ev.title.toLowerCase()}`,
    title: `Сэр, ${inMinutesPhrase(ev.startAt, now)} — ${ev.title} (в ${hhmm}).`,
    detail: ev.title,
    salience: 0.9, // встреча со сроком — важнее непрочитанного чата
    // Фраза привязана ко ВРЕМЕНИ и стареет БЫСТРО: «через 20 минут», зачитанное даже через 10 минут, —
    // уже ложь (контроль-4: прежний ttl «до начала встречи» позволял озвучить её за минуту до созвона).
    // Короткий срок годности безопасен: событие остаётся в окне, durable-seen у протухшего НЕ ставится,
    // и следующий тик (движок ре-поллит сразу после сброса) сформулирует фразу заново с актуальным «через N».
    ttlMs: PHRASE_TTL_MS,
    ts: now,
  };
}

/** Собрать ambient-источник календаря поверх ридера расширения. */
export function createCalendarSource(reader: CalendarReader, ownerUserId: string, opts: CalendarSourceOpts = {}): AmbientSource {
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled ?? (() => true);
  const leadMs = opts.leadMs ?? envInt("JARVIS_CALENDAR_LEAD_MS", 20 * 60_000);
  /** Троттл деградаций: вкладка может быть сломана часами — не заливаем лог каждые 90с. */
  let lastDegradeAt = 0;
  const noteDegradation = (kind: string, meta: Record<string, unknown>): void => {
    const t = now();
    if (t - lastDegradeAt < 30 * 60_000) return;
    lastDegradeAt = t;
    try {
      metrics.recordDegradation(kind, meta);
    } catch {
      /* наблюдаемость не должна ронять источник */
    }
    log.warn("календарь прочитать не удалось", { kind, ...meta });
  };
  return {
    id: "calendar",
    label: "Календарь (открытая вкладка)",
    enabled,
    poll: async () => {
      let res: CalendarReadResult;
      try {
        res = ((await reader.calendarRead()) ?? {}) as CalendarReadResult;
      } catch (e) {
        log.debug("calendar.read недоступен (расширение/вкладка) — пропуск", e instanceof Error ? e.message : String(e));
        return [];
      }
      if (res.noTab) return []; // вкладки нет — молчим (владелец не просил лезть в браузер)
      if (res.blank || res.ok === false) {
        noteDegradation("calendar_unreadable", { reason: res.blank ? "blank" : (res.error ?? "error").slice(0, 120) });
        return [];
      }
      if (!Array.isArray(res.events)) return [];
      const t = now();
      const parsed = parseCalendarChips(res.events, t);
      // Разметка изменилась/незнакома: чипы есть, а моментов ноль — это НЕ «встреч нет».
      if (parsed.events.length === 0 && parsed.unparsed > 0) {
        noteDegradation("calendar_chips_unparsed", { chips: res.events.length, host: res.host });
        return [];
      }
      // СМЕШАННЫЙ случай (контроль-11): часть разобрали, часть нет — сигналы по разобранному отдаём
      // (лучше предупредить о том, что видим), но слепота обязана быть видимой в метриках, иначе
      // «почему не предупредил о встрече» разбирать не по чему.
      if (parsed.unparsed > 0) noteDegradation("calendar_chips_unparsed", { chips: res.events.length, parsed: parsed.events.length, host: res.host });
      // Предупреждаем только о событиях со ВРЕМЕНЕМ: «весь день» в 00:00 — не повод будить.
      return upcomingEvents(parsed.events, t, leadMs)
        .filter((e) => !e.allDay)
        .map((e) => eventSignal(e, ownerUserId, t));
    },
  };
}
