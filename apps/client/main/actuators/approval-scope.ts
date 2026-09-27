/**
 * W2 (решение №3): ОБЛАСТЬ ОДОБРЕНИЯ — откуда пришла исполняемая команда и какое одобрение §14 у неё есть.
 *
 * Одобрение владельца (`ActionCommand.approval`, гранты) ставит ТОЛЬКО сервер. Рубеж инжекции читает его НЕ из команды
 * (её тело может прийти с SDK-моста — python под prompt-injection впишет туда что угодно, N-3), а из области, которую
 * открыл транспорт при исполнении серверной команды. У моста, локального реплея и UI области с одобрением нет →
 * рубеж отказывает fail-closed (П1).
 *
 * Счётчики грантов — КОПИЯ в сторе области (`grantsLeft`): списание не трогает конверт команды и видно всем вложенным
 * областям той же команды (act кладёт `expectedForeground` вложенным run — массив грантов тот же).
 * AsyncLocalStorage — только `run()` (никаких `enterWith`: область обязана закрываться вместе с вызовом, иначе
 * одобрение «протекает» в чужие асинхронные цепочки — таймеры, подписки сайдкара).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionCommand, ActionResult, CommitApproval, CommitGrant } from "@jarvis/protocol";

/** Кто исполняет: команда сервера (транспорт) | SDK-мост (code_run) | локальный реплей/UI клиента. */
export type ScopeVia = "server" | "bridge" | "local";

/** Окно, которое act сфокусировал по `app` (G-11): клавиатура обязана уйти именно в него. */
export interface ExpectedForeground {
  hwnd: number;
  title: string;
}

export interface ApprovalScope {
  via: ScopeVia;
  commandId?: string;
  /** Одобрение серверной команды (только via:"server"). */
  approval?: CommitApproval;
  /** Остаток грантов — копия из конверта, списывает рубеж §14 (commit-judge). */
  grantsLeft?: CommitGrant[];
  expectedForeground?: ExpectedForeground;
}

export type CommandExecutorFn = (commandId: string, cmd: ActionCommand) => Promise<ActionResult>;

const als = new AsyncLocalStorage<ApprovalScope>();

/** Текущая область (undefined — вне любой: таймер, подписка, локальный UI-путь без обёртки). */
export function currentScope(): ApprovalScope | undefined {
  return als.getStore();
}

/** Грант из конверта — только с валидными полями (сервер свой, но счётчик не должен стать NaN/отрицательным). */
function copyGrants(a: CommitApproval | undefined): CommitGrant[] {
  if (!a || !Array.isArray(a.grants)) return [];
  return a.grants
    .filter((g) => g && typeof g.signature === "string" && typeof g.process === "string" && Number.isFinite(g.count) && g.count > 0)
    .map((g) => ({ signature: g.signature, process: g.process, count: Math.floor(g.count), ...(typeof g.hwnd === "number" ? { hwnd: g.hwnd } : {}), ...(g.host ? { host: g.host } : {}) }));
}

/** Исполнитель транспорта: команда сервера идёт в своей области с одобрением из конверта. */
export function serverExecutor(dispatch: CommandExecutorFn): CommandExecutorFn {
  return (commandId, cmd) => {
    const scope: ApprovalScope = { via: "server", commandId, ...(cmd.approval ? { approval: cmd.approval, grantsLeft: copyGrants(cmd.approval) } : {}) };
    return als.run(scope, () => dispatch(commandId, cmd));
  };
}

/**
 * Исполнить без одобрения (мост, локальный реплей): новая область БЕЗ `approval`, даже если вызов пришёл изнутри
 * одобренной серверной команды (python из code_run дёрнул мост во время её исполнения).
 */
export function runWithoutApproval<T>(via: Exclude<ScopeVia, "server">, fn: () => T, commandId?: string): T {
  return als.run({ via, ...(commandId ? { commandId } : {}) }, fn);
}

/**
 * act (G-11): дальнейшая клавиатура — только в окно `fg`. Вложенная область с ТЕМИ ЖЕ грантами (ссылка на массив):
 * списание внутри act видно команде. Вне любой области — локальная без одобрения (fail-closed для коммитов).
 */
export function withExpectedForeground<T>(fg: ExpectedForeground, fn: () => T): T {
  return als.run({ ...(als.getStore() ?? { via: "local" as const }), expectedForeground: fg }, fn);
}

/** Действующие гранты области: только серверная команда и только до `expiresAt`. */
export function liveGrants(scope: ApprovalScope | undefined, now = Date.now()): CommitGrant[] {
  if (!scope || scope.via !== "server" || !scope.approval || !scope.grantsLeft) return [];
  return scope.approval.expiresAt > now ? scope.grantsLeft : [];
}
