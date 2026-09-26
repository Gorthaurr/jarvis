/**
 * W2 (пакет 0): ошибка актуатора с ПРОТОКОЛЬНЫМ исходом — код, данные и признак «часть действия ушла».
 *
 * Раньше dispatch знал поимённо два класса (вуаль, частичный act); рубежу инжекции нужен третий (`denied` +
 * `data.needsApproval`) — и каждый новый класс был бы ещё одной веткой catch. Теперь catch читает поля
 * (`actionCode`/`actionData`/`injected`) у ЛЮБОЙ ошибки: ActionError, DrawingOverlayError, ActPartialError.
 */
import type { ActionResult } from "@jarvis/protocol";

export type ActionErrorCode = NonNullable<ActionResult["error"]>["code"];

export class ActionError extends Error {
  readonly actionCode: ActionErrorCode;
  readonly actionData?: unknown;
  /** Часть действия УЖЕ ушла в GUI — исход неизвестен (сервер: uncertain, без повтора). */
  readonly injected: boolean;
  constructor(message: string, opts: { code: ActionErrorCode; data?: unknown; injected?: boolean }) {
    super(message);
    this.name = "ActionError";
    this.actionCode = opts.code;
    if (opts.data !== undefined) this.actionData = opts.data;
    this.injected = opts.injected === true;
  }
}

const CODES: ReadonlySet<string> = new Set<ActionErrorCode>(["timeout", "not_found", "denied", "disconnected", "channel_down", "runtime", "overlay_drawing"]);

/** Протокольный исход ошибки (по полям, не по классу); обычная ошибка → null (dispatch: runtime). */
export function actionErrorOf(e: unknown): { code: ActionErrorCode; data?: unknown; injected: boolean } | null {
  if (!e || typeof e !== "object") return null;
  const x = e as { actionCode?: unknown; actionData?: unknown; injected?: unknown };
  if (typeof x.actionCode !== "string" || !CODES.has(x.actionCode)) return null;
  return { code: x.actionCode as ActionErrorCode, ...(x.actionData !== undefined ? { data: x.actionData } : {}), injected: x.injected === true };
}
