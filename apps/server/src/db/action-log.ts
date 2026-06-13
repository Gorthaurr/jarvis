/**
 * action_log — журнал выполненных действий (§13).
 *
 * Каждый ActionCommand и его ActionResult пишутся сюда для аудита, отладки
 * и последующей консолидации навыков (§8). Запись best-effort: при недоступной
 * БД — no-op + warn, чтобы не ломать round-trip действия в M0.
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "./pool.js";

const log: Logger = createLogger("action-log");

/** Запись журнала действий (соответствует таблице action_log, §13). */
export interface ActionLogEntry {
  sessionId: string;
  /** = envelope.id команды (commandId). */
  commandId: string;
  kind: ActionCommand["kind"];
  /** Сериализованная команда (без секретов; карточные данные не пишем — §0 принцип 5). */
  command: ActionCommand;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
  /** unix ms момента записи. */
  at: number;
}

/**
 * Записать строку журнала. Безопасно при отсутствии БД (no-op).
 * Возвращает true, если запись реально ушла в БД.
 */
export async function insertActionLog(entry: ActionLogEntry): Promise<boolean> {
  const res = await query(
    `insert into action_log
       (session_id, command_id, kind, command, ok, error_code, error_message, duration_ms, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))`,
    [
      entry.sessionId,
      entry.commandId,
      entry.kind,
      JSON.stringify(redact(entry.command)),
      entry.ok,
      entry.errorCode ?? null,
      entry.errorMessage ?? null,
      entry.durationMs,
      entry.at,
    ],
  );
  if (res === null) {
    // БД недоступна — пишем в обычный лог, чтобы след всё же остался.
    log.debug("action_log no-op (нет БД)", {
      commandId: entry.commandId,
      kind: entry.kind,
      ok: entry.ok,
    });
    return false;
  }
  return true;
}

/** Удобный конструктор записи из команды и результата. */
export function buildActionLogEntry(
  sessionId: string,
  commandId: string,
  command: ActionCommand,
  result: ActionResult,
): ActionLogEntry {
  return {
    sessionId,
    commandId,
    kind: command.kind,
    command,
    ok: result.ok,
    errorCode: result.error?.code,
    errorMessage: result.error?.message,
    durationMs: result.durationMs,
    at: Date.now(),
  };
}

/**
 * Вырезать чувствительные поля перед записью в журнал.
 * §0 принцип 5: карточные/платёжные данные НЕ логируются даже частично.
 */
function redact(command: ActionCommand): ActionCommand {
  if (command.kind === "order.place") {
    // total и vendor оставляем для аудита, но items могут нести реквизиты —
    // схлопываем в количество позиций, не сохраняя содержимое.
    return {
      ...command,
      items: command.items.map(() => ({ redacted: true })),
    };
  }
  return command;
}
