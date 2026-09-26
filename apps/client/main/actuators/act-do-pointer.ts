/**
 * W2 (пакет 0): глаголы указателя gui.act — triple, middle, hover, drag, scroll. ЗАГЛУШКА: отказ до любого действия
 * (act-args.ts отсекает их ещё раньше). Реализует П4: triple = клик ×3; middle; hover = move в центр (bbox →
 * physicalRectToDip или точка); scroll = колесо в элементе/точке (dx/dy, обход G-17); drag = к `to` (findTarget).
 */
import type { FoundTarget } from "./act-find.js";
import type { ActCommand } from "./act-args.js";
import type { ActDone, ActParams } from "./act-do.js";

export type PointerVerb = "triple" | "middle" | "hover" | "drag" | "scroll";

export async function doPointer(_found: FoundTarget, verb: PointerVerb, _cmd: ActCommand, _p: ActParams): Promise<ActDone> {
  throw new Error(`act do:${verb} пока не поддержан — ничего не нажато`);
}
