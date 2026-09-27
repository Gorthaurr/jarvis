/**
 * W2 (пакет 0, решение №3): ОБЛАСТЬ ОДОБРЕНИЯ — откуда пришла исполняемая команда и какое одобрение §14 у неё есть.
 *
 * Одобрение владельца (`ActionCommand.approval`, гранты) ставит ТОЛЬКО сервер. Рубеж инжекции читает его НЕ из команды
 * (её тело может прийти с SDK-моста — python под prompt-injection впишет туда что угодно, N-3), а из области, которую
 * открыл транспорт при исполнении серверной команды. У моста, локального реплея и UI области с одобрением нет →
 * рубеж отказывает fail-closed (П1).
 *
 * AsyncLocalStorage — только `run()` (никаких `enterWith`: область обязана закрываться вместе с вызовом, иначе
 * одобрение «протекает» в чужие асинхронные цепочки — таймеры, подписки сайдкара).
 * Владелец после P0 — П1 (счётчики грантов — копия в сторе, привязка подписчиков к контексту загрузки).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionCommand, ActionResult, CommitApproval } from "@jarvis/protocol";

/** Кто исполняет: команда сервера (транспорт) | SDK-мост (code_run) | локальный реплей/UI клиента. */
export type ScopeVia = "server" | "bridge" | "local";

export interface ApprovalScope {
  via: ScopeVia;
  commandId?: string;
  /** Одобрение серверной команды (только via:"server"). */
  approval?: CommitApproval;
}

export type CommandExecutorFn = (commandId: string, cmd: ActionCommand) => Promise<ActionResult>;

const als = new AsyncLocalStorage<ApprovalScope>();

/** Текущая область (undefined — вне любой: таймер, подписка, локальный UI-путь без обёртки). */
export function currentScope(): ApprovalScope | undefined {
  return als.getStore();
}

/** Исполнитель транспорта: команда сервера идёт в своей области с одобрением из конверта. */
export function serverExecutor(dispatch: CommandExecutorFn): CommandExecutorFn {
  return (commandId, cmd) => als.run({ via: "server", commandId, ...(cmd.approval ? { approval: cmd.approval } : {}) }, () => dispatch(commandId, cmd));
}

/**
 * Исполнить без одобрения (мост, локальный реплей): новая область БЕЗ `approval`, даже если вызов пришёл изнутри
 * одобренной серверной команды (python из code_run дёрнул мост во время её исполнения).
 */
export function runWithoutApproval<T>(via: Exclude<ScopeVia, "server">, fn: () => T, commandId?: string): T {
  return als.run({ via, ...(commandId ? { commandId } : {}) }, fn);
}
