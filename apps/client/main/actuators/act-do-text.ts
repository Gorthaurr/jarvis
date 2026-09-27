/**
 * W4 «Руки» / W2 (П4): ПЕЧАТЬ примитива gui.act — `type` (клик в поле + печать), печать в поле с фокусом (без цели),
 * `clear` (очистить поле перед печатью) и `enter` (Enter после печати). Вынесено из act-do.ts.
 *
 * clear — ТОЛЬКО по роли найденного элемента: Edit / Document / редактируемый ComboBox. Роль иная или неизвестна
 * (точка без UIA-элемента, пункт списка) → честная ошибка ДО любого ввода: Ctrl+A → Delete по кнопке или строке чата
 * удалил бы не то. Путь: UIA setValue "" (без клавиатуры); не принят (паттерна нет) → после клика в поле Ctrl+A →
 * Delete; у ComboBox клавишами не чистим (редактируемость без C# не узнать) — только setValue.
 * enter — `pressKey("Enter")` ПОСЛЕ печати, через рубеж инжекции (§14 судит Enter как коммит). Всё, что уходит
 * после первого действия и падает, — ActPartialError (исход неизвестен, без повтора).
 * Экранные координаты для авто-макроса §8 отдаём только у «голой» печати: clear/enter макрос не повторит.
 */
import { DrawingOverlayError } from "../selection/overlay-error.js";
import type { ActCommand } from "./act-args.js";
import type { FoundTarget } from "./act-find.js";
import { type ActDone, ActPartialError, type ActParams } from "./act-do.js";
import { mirrorOf } from "./handle-mirror.js";
import { injectRpc } from "./inject.js";
import { click, pressKey, typeText } from "./input.js";
import { PASTE_FROM_CHARS, pasteNote, pasteText } from "./paste-text.js";
import { sidecar } from "./sidecar-client.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** «ControlType.Edit» / «edit» → «edit». */
const roleKey = (r: string | undefined): string => String(r ?? "").trim().toLowerCase().replace(/^controltype\./u, "");
const gen = (): number => (sidecar() as { generation?: number }).generation ?? 0;

/** Роль и значение найденного элемента: у handle-цели их знает зеркало (снапшот/ground). */
function elementOf(f: FoundTarget): { role: string; value?: string | null } {
  const m = f.handle ? mirrorOf(f.handle, gen()) : null;
  return { role: roleKey(f.role ?? m?.role), value: m?.value };
}

/** Можно ли чистить и как. Бросает ДО любого ввода. */
function clearPlan(f: FoundTarget): "keys-ok" | "uia-only" {
  const el = elementOf(f);
  if (el.role === "edit" || el.role === "document") return "keys-ok";
  if (el.role === "combobox" && typeof el.value === "string" && f.handle) return "uia-only";
  const what = el.role ? `роль «${el.role}»` : "роль неизвестна (найдена точка, не UIA-поле)";
  throw new Error(`act clear:true — «${f.name}»: ${what}; очищаю только поля ввода (Edit, Document, редактируемый ComboBox). Ничего не нажато.`);
}

/** Печать текста: длинный — вставкой (H-T1). */
async function typeOrPaste(text: string): Promise<string> {
  if (text.length >= PASTE_FROM_CHARS) return pasteNote(await pasteText(text));
  await typeText(text);
  return "";
}

/** Шаг ПОСЛЕ первого действия: провал → ActPartialError (исход неизвестен), вуаль — как есть. */
async function after<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof DrawingOverlayError) throw e;
    throw new ActPartialError(`${what}: ${msg(e)} — исход неизвестен, не повторяй вслепую`);
  }
}

/** UIA setValue "" по handle (осознанное пустое намерение — invoke() ground.ts пустое значение отвергает). */
async function uiaClear(f: FoundTarget): Promise<boolean> {
  try {
    await injectRpc("invoke", { handle: f.handle, pattern: "setValue", value: "" }, 12_000);
    return true;
  } catch (e) {
    if (e instanceof DrawingOverlayError) throw e;
    // Таймаут — поле могло очиститься (исход неизвестен); прочие ошибки — паттерна нет / только чтение: ничего не ушло.
    if (/timeout|таймаут/iu.test(msg(e))) throw new ActPartialError(`очистка «${f.name}» через UIA ушла, ответа нет — исход неизвестен`);
    return false;
  }
}

/** type по цели: [clear] → клик в поле → [Ctrl+A → Delete] → печать → [Enter]. */
export async function doType(f: FoundTarget, cmd: ActCommand, p: ActParams): Promise<ActDone> {
  const text = p.text ?? "";
  const target = f.handle ? ({ by: "handle", handle: f.handle } as const) : f.point ? ({ by: "coords", x: f.point.x, y: f.point.y, space: "screen" } as const) : null;
  if (!target) throw new Error(`«${f.name}»: некуда кликнуть перед печатью (нет handle/точки)`);
  const plan = cmd.clear === true ? clearPlan(f) : null;
  let cleared = plan !== null && f.handle ? await uiaClear(f) : false;
  if (plan === "uia-only" && !cleared) throw new Error(`act clear:true — «${f.name}»: ComboBox не принял очистку через UIA (только для чтения?), клавишами не чищу. Ничего не нажато.`);
  const clickIt = () => click(target, p.physical ? "physical" : "silent", p.restoreCursor);
  const r = cleared ? await after(`поле «${f.name}» очищено, клик в него не удался`, clickIt) : await clickIt();
  if (plan && !cleared) {
    await after(`клик в «${f.name}» ушёл, очистка клавишами не удалась`, async () => {
      await pressKey("Ctrl+A");
      await pressKey("Delete");
    });
    cleared = true;
  }
  const note = await after(`клик в «${f.name}» ушёл, печать не удалась`, () => typeOrPaste(text));
  if (cmd.enter === true) await after(`напечатал в «${f.name}», Enter не нажат`, () => pressKey("Enter"));
  const bare = !cleared && cmd.enter !== true;
  return {
    did: `${cleared ? "очистил поле и " : ""}напечатал ${text.length} симв. в «${f.name}»${cmd.enter === true ? " и нажал Enter" : ""}${note}`,
    ...(bare ? { screenX: r?.screenX, screenY: r?.screenY } : {}),
    physical: Boolean(p.physical),
  };
}

/**
 * type БЕЗ цели: печать в поле, где УЖЕ стоит фокус (после Ctrl+K/Ctrl+L, игрового чата) — без холодного input_type.
 * Кликать некуда; окно выбирает `app` act (фокус ДО печати). Упала посреди — часть символов могла уйти.
 */
export async function doTypeFocused(cmd: ActCommand, p: ActParams): Promise<ActDone> {
  const text = p.text ?? "";
  const note = await after("печать в поле с фокусом не удалась (часть текста могла уйти)", () => typeOrPaste(text));
  if (cmd.enter === true) await after("напечатал в поле с фокусом, Enter не нажат", () => pressKey("Enter"));
  return { did: `напечатал ${text.length} симв. в поле с фокусом${cmd.enter === true ? " и нажал Enter" : ""}${note}`, physical: true };
}
