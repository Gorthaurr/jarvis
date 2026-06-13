/**
 * Календарь (§12) — read-only интерфейс + стаб.
 *
 * Источник событий для проактивных напоминаний (§9). Только чтение: Jarvis
 * не создаёт/не меняет события без явного запроса. Без интеграции — пустой список.
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("calendar");

export interface CalendarEvent {
  id: string;
  title: string;
  /** unix ms начала. */
  startTs: number;
  /** unix ms конца. */
  endTs: number;
  location?: string;
}

export interface ICalendarProvider {
  /** События в окне [fromTs, toTs]. */
  listEvents(userId: string, fromTs: number, toTs: number): Promise<CalendarEvent[]>;
  readonly live: boolean;
}

/** Стаб календаря — read-only, пустой (до подключения провайдера). */
export class StubCalendarProvider implements ICalendarProvider {
  readonly live = false;
  constructor() {
    log.warn("календарь не подключён — listEvents → []");
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async listEvents(_userId: string, _fromTs: number, _toTs: number): Promise<CalendarEvent[]> {
    // TODO(M5/§12): read-only интеграция (CalDAV/Google/Yandex).
    return [];
  }
}
