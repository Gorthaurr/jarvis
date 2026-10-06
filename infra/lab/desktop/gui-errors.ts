import type { ErrCode } from "./core.js";
/** Ошибка с протокольным исходом (код, данные, «часть действия ушла») — как ActionError настоящего клиента. */
export class ActionError extends Error {
  constructor(
    message: string,
    readonly code: ErrCode = "runtime",
    readonly data?: unknown,
    readonly injected = false,
  ) {
    super(message);
    this.name = "ActionError";
  }
}
