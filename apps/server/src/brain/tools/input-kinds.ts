/**
 * Классификация действий по «занятости физического ввода» (§20).
 *
 * Параллельное исполнение фоновых задач безопасно ровно до тех пор, пока две
 * задачи не дерутся за общий ввод — мышь/клавиатуру/фокус окна. Команды, которые
 * синтезируют ввод, крадут фокус/открывают окно или гонят страницу через CDP,
 * обязаны идти под арендой ввода (AsyncMutex на сессию); всё остальное
 * (web/память/файлы/чтение a11y/код в песочнице/Office-COM/медиа-клавиши)
 * безопасно параллелить — оно не трогает курсор.
 */
import type { ActionKind } from "@jarvis/protocol";
import { ACTUATOR_KIND_BY_TOOL } from "@jarvis/tools";

/**
 * Виды команд, требующие эксклюзивной аренды ввода (§20): прямой синтез ввода,
 * кража фокуса/окна, драйв страницы и пошаговый скилл (последовательность кликов),
 * и browser-чекаут заказа. Office (отдельные COM-инстансы) и system.* (медиа/
 * громкость/буфер/блокировка) за курсор НЕ дерутся → не входят сюда.
 */
export const INPUT_BEARING_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "input.type",
  "input.key",
  "input.click",
  "ui.invoke",
  "app.launch",
  "app.focus",
  "app.close",
  "browser.open",
  "browser.act",
  "skill.execute",
  "order.place",
]);

/** Требует ли вид команды аренды ввода (§20). */
export function kindNeedsInput(kind: ActionKind): boolean {
  return INPUT_BEARING_KINDS.has(kind);
}

/**
 * Приведёт ли вызов инструмента модели к команде, занимающей ввод. Серверные
 * инструменты (web_search, memory_*, tool_*) не эмитят ActionCommand → нет;
 * самописные инструменты резолвятся в code.run (песочница, без GUI) → тоже нет.
 */
export function toolNeedsInput(name: string): boolean {
  const kind = ACTUATOR_KIND_BY_TOOL[name];
  return kind ? kindNeedsInput(kind) : false;
}
