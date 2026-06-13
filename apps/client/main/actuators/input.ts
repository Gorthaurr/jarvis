/**
 * Актуатор синтетического ввода (мышь/клавиатура) через win-сайдкар (§6).
 *
 * Синтетический ввод (SendInput) — это FALLBACK (§6): основной путь действия — UIA-паттерны
 * (см. ground.ts / ui.invoke). input.click/input.type/input.key используются только там,
 * где UIA недоступна (canvas, игры, кастомный рендер).
 *
 * Реальный SendInput живёт в нативном сайдкаре apps/sidecar-win (C#/.NET), а main общается
 * с ним по IPC (stdin/stdout JSON или named pipe). Здесь — типизированный стаб контракта.
 *
 * // TODO(M3): поднять IPC-канал к сайдкару и реализовать send*().
 */
import type { Target } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";

const log = createLogger("actuator:input");

/** Текст печатается посимвольно с человеческим джиттером в сайдкаре (§3 принцип 3). */
export async function typeText(_text: string): Promise<void> {
  log.warn("input.type вызван, но сайдкар не реализован (M3)");
  throw new NotImplementedError("input.type");
}

/** combo в нотации протокола: "Ctrl+S", "ArrowRight", "Space". */
export async function pressKey(_combo: string): Promise<void> {
  log.warn("input.key вызван, но сайдкар не реализован (M3)");
  throw new NotImplementedError("input.key");
}

/** Клик по цели. coords-таргет — крайний случай; role/handle резолвит ground.ts. */
export async function click(_target: Target): Promise<void> {
  log.warn("input.click вызван, но сайдкар не реализован (M3)");
  throw new NotImplementedError("input.click");
}

/** Единый маркер «не реализовано» — dispatch маппит его в ActionResult.error.runtime. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what}: синтетический ввод не реализован (M3, сайдкар apps/sidecar-win)`);
    this.name = "NotImplementedError";
  }
}
