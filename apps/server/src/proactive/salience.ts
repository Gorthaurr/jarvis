/**
 * Salience — стоит ли прерывать пользователя проактивным сообщением (§9).
 *
 * Вход: текущий ClientContext (занятость/DND/блокировка) + сработавший триггер.
 * Выход: можно ли сейчас озвучить nudge. Жёсткие правила (DND, звонок, fullscreen,
 * locked) — детерминированы здесь. Тонкая оценка уместности (Haiku-проверка
 * «реально ли это сейчас важно») — TODO(M5) за интерфейсом.
 */
import type { ClientContext } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import type { Trigger } from "./triggers/index.js";

const log: Logger = createLogger("salience");

/** Последний известный контекст по сессии (вход salience). */
const lastContextBySession = new Map<string, ClientContext>();

/** Запомнить контекст клиента (вызывает router при client.context). */
export function noteClientContext(sessionId: string, ctx: ClientContext): void {
  lastContextBySession.set(sessionId, ctx);
}

/** Забыть контекст при закрытии сессии. */
export function forgetClientContext(sessionId: string): void {
  lastContextBySession.delete(sessionId);
}

export interface SalienceDecision {
  interrupt: boolean;
  reason: string;
}

export interface SalienceOptions {
  /** Пользовательский do-not-disturb (§9). Жёсткие дедлайны идут мобильным пушем. */
  dnd?: boolean;
}

/**
 * Решение о прерывании (§9).
 * @param ctx текущий контекст (если неизвестен — считаем фон спокойным).
 * @param trigger сработавший триггер с собственной важностью.
 * @param opts пользовательские настройки (DND).
 */
export function shouldInterrupt(
  ctx: ClientContext | undefined,
  trigger: Trigger,
  opts: SalienceOptions = {},
): SalienceDecision {
  // 0) DND — жёсткий запрет голосового вмешательства (§9). Срочное — мобильным пушем.
  if (opts.dnd) {
    log.debug("salience: DND активен — голос подавлен", { trigger: trigger.id });
    return { interrupt: false, reason: "do-not-disturb (доставка пушем при необходимости)" };
  }

  // 1) Жёсткие блокировки — не беспокоим ни при каких обстоятельствах,
  //    кроме триггеров критической важности (будильник/срочное напоминание).
  if (ctx) {
    if (ctx.micBusyByOtherApp) {
      return deny(trigger, "микрофон занят звонком/коммуникатором");
    }
    if (ctx.locked) {
      return deny(trigger, "экран заблокирован");
    }
    if (ctx.fullscreen && trigger.importance < 0.8) {
      return deny(trigger, "пользователь в полноэкранном режиме");
    }
  }

  // 2) Порог важности триггера. TODO(M5): здесь Haiku-проверка контекстной
  //    уместности (учесть activeApp, тему задачи, историю отклонений).
  if (trigger.importance < 0.3) {
    return deny(trigger, "важность ниже порога");
  }

  log.debug("salience: прерывание разрешено", { trigger: trigger.id });
  return { interrupt: true, reason: "контекст допускает прерывание" };

  function deny(t: Trigger, reason: string): SalienceDecision {
    // Критичные триггеры пробивают мягкие блокировки (fullscreen), но не DND/locked.
    if (t.importance >= 0.95 && reason === "пользователь в полноэкранном режиме") {
      return { interrupt: true, reason: "критический триггер пробивает fullscreen" };
    }
    log.debug("salience: прерывание отклонено", { trigger: t.id, reason });
    return { interrupt: false, reason };
  }
}

/**
 * Очередь отложенных nudge (§9): когда пользователь занят, копим и доставляем
 * при освобождении. Истёкшие (expiresAt) на flush отбрасываются — «выходи в 8:20»,
 * сказанное в 11:00, хуже молчания (§9).
 */
export class NudgeQueue {
  private readonly byUser = new Map<string, Trigger[]>();

  enqueue(t: Trigger): void {
    const arr = this.byUser.get(t.userId) ?? [];
    arr.push(t);
    this.byUser.set(t.userId, arr);
  }

  /** Достать доставимые триггеры (не истёкшие) и очистить очередь юзера. */
  flush(userId: string, now: number): Trigger[] {
    const arr = this.byUser.get(userId) ?? [];
    this.byUser.delete(userId);
    return arr.filter((t) => t.expiresAt > now);
  }

  size(userId: string): number {
    return this.byUser.get(userId)?.length ?? 0;
  }
}

/** Истёк ли nudge (§9): просроченное не доставляется, молча в лог. */
export function isExpired(expiresAt: number, now: number): boolean {
  return expiresAt <= now;
}
