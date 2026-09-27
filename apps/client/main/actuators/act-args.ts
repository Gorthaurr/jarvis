/**
 * W4 «Руки»: проверка аргументов gui.act ДО любого действия — неверная форма = честная ошибка, а не клик наугад.
 * W2 (пакет 0): вынесено из act.ts. Владелец — П4 (новые глаголы и поля clear/enter/to/dx/dy снимают отказ ниже).
 */
import type { ActionCommand } from "@jarvis/protocol";

export type ActCommand = Extract<ActionCommand, { kind: "gui.act" }>;

/** Глаголы указателя W2 — исполняет П4 (act-do-pointer.ts); до него честный отказ ДО поиска и действия. */
const POINTER_VERBS: ReadonlySet<string> = new Set(["triple", "middle", "hover", "drag", "scroll"]);

export function validateAct(cmd: ActCommand): void {
  const verb = cmd.do ?? "click";
  // Поля схемы W2, исполнение которых приходит в П4. Молча игнорировать нельзя: enter:true без Enter = ложное «сделал».
  if (cmd.clear === true || cmd.enter === true) throw new Error(`act ${cmd.clear ? "clear" : "enter"}:true пока не поддержан — ничего не нажато; нажми Enter отдельным act{do:"key"}`);
  if (POINTER_VERBS.has(verb)) throw new Error(`act do:${verb} пока не поддержан — ничего не нажато; используй click/double/right или input_mouse`);
  if (verb === "key" && !cmd.combo?.trim()) throw new Error("act do:key без combo");
  if ((verb === "type" || verb === "set") && !cmd.text) throw new Error(`act do:${verb} без text`);
  // key и type без цели законны: клавиша — в фокус; печать — в поле, где уже стоит фокус (после Ctrl+K/Ctrl+L).
  if (verb !== "key" && verb !== "type" && cmd.target === undefined) throw new Error(`act do:${verb} без target`);
}
