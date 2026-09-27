/**
 * Классификация действий по «занятости физического ввода» (§20).
 *
 * Параллельное исполнение фоновых задач безопасно ровно до тех пор, пока две
 * задачи не дерутся за общий ввод — мышь/клавиатуру/фокус окна. Команды, которые
 * синтезируют ввод, крадут фокус/открывают окно или гонят страницу через CDP,
 * обязаны идти под арендой ввода (AsyncMutex на сессию); всё остальное
 * (web/память/файлы/чтение a11y/код без SDK jarvis/Office-COM/медиа-клавиши)
 * безопасно параллелить — оно не трогает курсор.
 */
import type { ActionKind } from "@jarvis/protocol";
import { ACTUATOR_KIND_BY_TOOL } from "@jarvis/tools";
import { callDrivesInput, type ResolveCode } from "./code-input.js";

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
  "input.mouse", // §Волна2 (2.4): SendInput — та же мышь, тот же арбитраж
  "ui.invoke",
  "gui.act", // W4 «Руки»: фокус окна + клик/печать — та же мышь/клавиатура/фокус
  "app.launch",
  "app.focus",
  "app.close",
  "window.focus", // §Волна2 (2.4): кража фокуса — сериализуется как app.focus
  "browser.open", // выводит окно Chrome вперёд (фокус) — под арендой
  // W1 (L-11): руки во вкладке через расширение шлют СИНТЕТИЧЕСКИЕ события (chrome.scripting), мышь/клавиатуру ОС и
  // фокус окна не трогают; вид browser.act удалён из протокола (B-12). browser_act и browser_batch идут без аренды.
  "skill.execute",
  "order.place",
]);

/** Требует ли вид команды аренды ввода (§20). */
export function kindNeedsInput(kind: ActionKind): boolean {
  return INPUT_BEARING_KINDS.has(kind);
}

/**
 * Приведёт ли вызов инструмента модели к команде, занимающей ввод. Серверные
 * инструменты (web_search, memory_*, tool_*) не эмитят ActionCommand → нет.
 * W3 (G-14): code.run сам по себе ввод не трогает, но python-скрипт с `import jarvis` кликает и печатает через
 * мост актуаторов — судим по ВХОДУ (code-input.ts); самописный инструмент — по своему коду (резолвер из deps).
 * Без входа — по имени, как раньше.
 */
export function toolNeedsInput(name: string, input?: unknown, resolveCode?: ResolveCode): boolean {
  // §Волна2 (2.2): input_batch — серверный инструмент (не в карте актуаторов), но эмитит
  // skill.execute (серия GUI-шагов) → аренда ввода обязательна.
  if (name === "input_batch") return true;
  const kind = ACTUATOR_KIND_BY_TOOL[name];
  if (kind && kindNeedsInput(kind)) return true;
  return input !== undefined && callDrivesInput(name, input, resolveCode);
}
