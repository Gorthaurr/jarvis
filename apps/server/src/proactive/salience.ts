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

/**
 * Решение о прерывании (§9).
 * @param ctx текущий контекст (если неизвестен — считаем фон спокойным).
 * @param trigger сработавший триггер с собственной важностью.
 */
export function shouldInterrupt(ctx: ClientContext | undefined, trigger: Trigger): SalienceDecision {
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
