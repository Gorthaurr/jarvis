/**
 * Умное напоминание — расчёт момента триггера (§9).
 *
 * Идея: напомнить не «в момент события», а заранее, чтобы пользователь успел
 * собраться и доехать. Формула (§9):
 *
 *   triggerTs = eventTs − (etaMs + prepMs + bufferMs)
 *
 * где
 *   eventTs — когда нужно БЫТЬ на месте (unix ms);
 *   etaMs   — время в пути до места (из maps-провайдера, §9/§12);
 *   prepMs  — время на сборы (одеться/собрать вещи), оценка намерения;
 *   bufferMs— подушка на непредвиденное.
 *
 * computeTriggerTs — детерминированная чистая функция (реальна). ETA берётся
 * за интерфейсом IEtaProvider; стаб возвращает фиксированную оценку.
 */
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("scheduler");

/** Намерение, к которому привязано напоминание. */
export interface ReminderIntent {
  /** Что напомнить (черновик текста). */
  what: string;
  /** Когда нужно быть на месте (unix ms). */
  eventTs: number;
  /** Откуда/куда — для ETA (опционально). */
  origin?: string;
  destination?: string;
}

/** Поставщик ETA (§9, §12). Реальная реализация — maps.ts (OSRM/Yandex). */
export interface IEtaProvider {
  /** Время в пути в мс между точками; null если неизвестно. */
  estimateEtaMs(origin: string, destination: string): Promise<number | null>;
}

/** Стаб ETA: без сети возвращает фиксированную оценку 20 минут. */
export class StubEtaProvider implements IEtaProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async estimateEtaMs(_origin: string, _destination: string): Promise<number | null> {
    return 20 * 60_000; // TODO(M5/§12): реальный маршрут через maps.ts.
  }
}

/**
 * Рассчитать момент срабатывания напоминания (§9) — чистая, детерминированная.
 * Все слагаемые в мс. triggerTs не может быть в прошлом раньше now (клиппинг).
 */
export function computeTriggerTs(params: {
  eventTs: number;
  etaMs: number;
  prepMs: number;
  bufferMs: number;
  /** «сейчас» — для тестируемости; по умолчанию Date.now(). */
  now?: number;
}): number {
  const { eventTs, etaMs, prepMs, bufferMs } = params;
  const now = params.now ?? Date.now();

  const lead = Math.max(0, etaMs) + Math.max(0, prepMs) + Math.max(0, bufferMs);
  const triggerTs = eventTs - lead;

  // Если расчётный момент уже прошёл — напоминаем немедленно (лучше поздно).
  return Math.max(now, triggerTs);
}

/**
 * Высокоуровневый расчёт: достаёт ETA из провайдера и считает triggerTs.
 * Дефолтные prep/buffer заданы константами; вынесены в параметры для гибкости.
 */
export async function scheduleReminder(
  intent: ReminderIntent,
  eta: IEtaProvider,
  opts: { prepMs?: number; bufferMs?: number; now?: number } = {},
): Promise<{ triggerTs: number; etaMs: number }> {
  const prepMs = opts.prepMs ?? 10 * 60_000; // 10 мин на сборы по умолчанию
  const bufferMs = opts.bufferMs ?? 5 * 60_000; // 5 мин подушки

  let etaMs = 0;
  if (intent.origin && intent.destination) {
    etaMs = (await eta.estimateEtaMs(intent.origin, intent.destination)) ?? 0;
  }

  const triggerTs = computeTriggerTs({
    eventTs: intent.eventTs,
    etaMs,
    prepMs,
    bufferMs,
    now: opts.now,
  });
  log.debug("напоминание рассчитано", { what: intent.what, etaMs, triggerTs });
  return { triggerTs, etaMs };
}
