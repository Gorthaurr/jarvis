/**
 * Проактивные триггеры (§9) — скелет.
 *
 * Три класса источников:
 *   TimeTrigger     — наступило запланированное время (напоминание/сбор в дорогу);
 *   ContextTrigger  — изменился контекст (открыл приложение, тема разговора, геофенс);
 *   ExternalTrigger — внешнее событие (письмо, сообщение, изменение цены/статуса).
 *
 * Здесь — интерфейс и стаб-реализации. Реальные источники (cron, watcher'ы,
 * вебхуки) подключаются в M5. Каждый триггер несёт importance ∈ [0,1] —
 * вход для salience (§9).
 */

/** Унифицированный триггер. */
export interface Trigger {
  /** Стабильный id (для дедупликации/логов). */
  id: string;
  kind: "time" | "context" | "external";
  /** Важность ∈ [0,1] — порог/перебивание fullscreen решает salience. */
  importance: number;
  /** Текст-намёк (черновик nudge); финал формулирует brain. */
  hint: string;
  /** unix ms, после которого триггер протух (§9: nudge не произносится). */
  expiresAt: number;
  /** К какому пользователю относится. */
  userId: string;
  /** Произвольная нагрузка источника. */
  payload?: Record<string, unknown>;
}

/** Источник триггеров. emit вызывается рантаймом при появлении события. */
export interface TriggerSource {
  readonly kind: Trigger["kind"];
  /** Запустить источник; cb получает каждый новый триггер. */
  start(cb: (t: Trigger) => void): void;
  stop(): void;
}

// ── стаб-реализации (M5) ─────────────────────────────────────

/** Время → триггер. TODO(M5): связать со scheduler.computeTriggerTs + cron. */
export class TimeTriggerSource implements TriggerSource {
  readonly kind = "time" as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(_cb: (t: Trigger) => void): void {
    // TODO(M5): таймеры/cron на основе computeTriggerTs(...) (scheduler.ts).
  }
  stop(): void {
    /* no-op до M5 */
  }
}

/** Контекст → триггер. TODO(M5): подписка на client.context + геофенс. */
export class ContextTriggerSource implements TriggerSource {
  readonly kind = "context" as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(_cb: (t: Trigger) => void): void {
    // TODO(M5): анализ изменения activeApp/темы/геопозиции.
  }
  stop(): void {
    /* no-op до M5 */
  }
}

/** Внешние события → триггер. TODO(M5): вебхуки почты/мессенджеров/цен. */
export class ExternalTriggerSource implements TriggerSource {
  readonly kind = "external" as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(_cb: (t: Trigger) => void): void {
    // TODO(M5): интеграции web/calendar/geofence как источники.
  }
  stop(): void {
    /* no-op до M5 */
  }
}
