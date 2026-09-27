/**
 * W4 «Руки»: проверка аргументов gui.act ДО любого действия — неверная форма = честная ошибка, а не клик наугад.
 * W2 (П4): новые глаголы (triple/middle/hover/drag/scroll) и поля clear/enter/to/dx/dy. Поле, которое при этом глаголе
 * не исполняется, — ошибка, а не молчаливый пропуск: enter:true без Enter = ложное «сделал».
 */
import type { ActionCommand } from "@jarvis/protocol";

export type ActCommand = Extract<ActionCommand, { kind: "gui.act" }>;

/** Потолок тиков колеса за одно действие (sanity: 100 тиков — уже десятки экранов). */
export const SCROLL_MAX_TICKS = 100;

const ticks = (v: unknown): boolean => v === undefined || (Number.isInteger(v) && Math.abs(v as number) <= SCROLL_MAX_TICKS);

export function validateAct(cmd: ActCommand): void {
  const verb = cmd.do ?? "click";
  if (verb === "key" && !cmd.combo?.trim()) throw new Error("act do:key без combo");
  if ((verb === "type" || verb === "set") && !cmd.text) throw new Error(`act do:${verb} без text`);
  // key и type без цели законны: клавиша — в фокус; печать — в поле, где уже стоит фокус (после Ctrl+K/Ctrl+L).
  if (verb !== "key" && verb !== "type" && cmd.target === undefined) throw new Error(`act do:${verb} без target`);
  if ((cmd.clear === true || cmd.enter === true) && verb !== "type") throw new Error(`act ${cmd.clear === true ? "clear" : "enter"}:true — только с do:"type" (ничего не нажато)`);
  // clear судится по роли НАЙДЕННОГО поля (act-do-text): без цели роль не проверить — ничего не чистим вслепую.
  if (cmd.clear === true && cmd.target === undefined) throw new Error('act clear:true без target — укажи поле (роль проверяется до очистки); ничего не нажато');
  if (cmd.to !== undefined && verb !== "drag") throw new Error('act to — только с do:"drag" (ничего не нажато)');
  if (verb === "drag" && cmd.to === undefined) throw new Error("act do:drag без to — куда тащить");
  if ((cmd.dx !== undefined || cmd.dy !== undefined) && verb !== "scroll") throw new Error('act dx/dy — только с do:"scroll" (ничего не нажато)');
  if (verb === "scroll") {
    if (!ticks(cmd.dx) || !ticks(cmd.dy)) throw new Error(`act do:scroll: dx/dy — целые тики, не больше ${SCROLL_MAX_TICKS} по модулю`);
    if (!cmd.dx && !cmd.dy) throw new Error("act do:scroll без dy/dx — сколько тиков крутить (+вверх/−вниз)");
  }
}
