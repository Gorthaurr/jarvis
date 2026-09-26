/**
 * Готовность сайдкара для актуаторов ввода/UIA (§6): не поднят → честный NotImplementedError (dispatch → runtime).
 * W2 (пакет 0): вынесено из input.ts, чтобы модули рубежа и печати (type-chunks) не импортировали input.ts по кругу.
 */
import { sidecar } from "./sidecar-client.js";

/** Единый маркер «не реализовано/недоступно» — dispatch маппит его в error.runtime. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: синтетический ввод недоступен (win-сайдкар apps/sidecar-win)`);
    this.name = "NotImplementedError";
  }
}

export function ensureSidecar(what = "сайдкар не запущен"): void {
  if (!sidecar().ready) throw new NotImplementedError(what);
}
