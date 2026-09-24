/**
 * W4 «Руки» (2026-09-10): ДЕЙСТВИЕ примитива gui.act над найденной целью.
 *
 * Правило честности, ради которого модуль отдельный: ПОВТОР ТОЛЬКО ЕСЛИ НИЧЕГО НЕ УШЛО. UIA invoke по handle
 * либо срабатывает, либо бросает ДО действия (паттерн не поддержан / элемент пропал) — тогда законен
 * физический клик по тому же handle. Но если действие ушло (invoke вернул ok, печать началась), второй попытки
 * нет ни здесь, ни по провалу verify: второй клик по «Отправить» — это дубль сообщения.
 *
 * Бесшумный путь (UIA, курсор не трогаем) — по умолчанию; физический SendInput — только фолбэк, physical:true,
 * правый/двойной клик и цель-точка без UIA-элемента. Печать (type) = клик в поле (лестница input.click:
 * invoke → физический по handle) + посимвольный ввод; set = UIA setValue (мгновенно, без клавиатуры).
 */
import type { ActVerb } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { DrawingOverlayError } from "../selection/overlay-error.js";
import type { FoundTarget } from "./act-find.js";
import { invoke } from "./ground.js";
import { click, pressKey, typeText } from "./input.js";
import { PASTE_FROM_CHARS, pasteText } from "./paste-text.js";

const log = createLogger("actuator:act-do");

export interface ActDone {
  /** Что сделано, по-русски (едет модели как факт, не как claim успеха). */
  did: string;
  /** Разрешённые экранные DIP физического клика (для авто-макроса §8); у UIA-пути их нет. */
  screenX?: number;
  screenY?: number;
  /** Действие ушло физическим вводом (SendInput), а не UIA. */
  physical: boolean;
}

/**
 * Часть действия УЖЕ УШЛА в GUI, остаток не удался (клик в поле прошёл, печать упала). Это не «не выполнено»:
 * dispatch помечает результат stepActionInjected, сервер — «исход неизвестен», повтор вслепую запрещён.
 */
export class ActPartialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActPartialError";
  }
}

export interface ActParams {
  text?: string;
  combo?: string;
  physical?: boolean;
  restoreCursor: boolean;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Физический клик (правый/двойной — только так: UIA-паттерна для них нет). Ревью 2026-09-24 (H-A1): цель, найденная
 * ТОЧКОЙ (координаты/OCR), кликается В ЭТУ ТОЧКУ — клик по handle = центр элемента, а под точкой мог оказаться
 * крупный родитель. По handle — только цель из снапшота (у неё точки нет, центр элемента и есть цель).
 */
async function physicalClick(f: FoundTarget, p: ActParams, opts: { button?: "left" | "right" | "middle"; count?: number }): Promise<ActDone> {
  const target = f.point
    ? ({ by: "coords", x: f.point.x, y: f.point.y, space: "screen" } as const)
    : f.handle
      ? ({ by: "handle", handle: f.handle } as const)
      : null;
  if (!target) throw new Error(`«${f.name}»: ни handle, ни точки — кликнуть физически нечем`);
  const r = await click(target, "physical", p.restoreCursor, opts);
  const how = opts.button === "right" ? "правый клик" : (opts.count ?? 1) > 1 ? "двойной клик" : "физический клик";
  return { did: `${how} по «${f.name}»`, screenX: r?.screenX, screenY: r?.screenY, physical: true };
}

/** click: UIA invoke по handle; бросил ДО действия → физический клик по тому же handle; точка без handle → физический. */
async function doClick(f: FoundTarget, p: ActParams): Promise<ActDone> {
  if (f.handle && !p.physical) {
    try {
      await invoke({ by: "handle", handle: f.handle }, "invoke");
      return { did: `UIA invoke «${f.name}»`, physical: false };
    } catch (e) {
      if (e instanceof DrawingOverlayError) throw e;
      // Ревью 2026-09-24 (H-T2): ТАЙМАУТ invoke ≠ «не сработал». Invoke Win32-кнопки блокирует до закрытия модального
      // окна, которое сам и открыл; сайдкар исполняет мутации строго по очереди — «фолбэк» физическим кликом встал
      // бы в очередь и нажал бы ещё раз после закрытия диалога. Исход неизвестен — второго клика нет.
      if (/timeout|таймаут/i.test(msg(e))) {
        throw new ActPartialError(`UIA invoke «${f.name}» ушёл, ответа нет (${msg(e).slice(0, 80)}) — исход неизвестен, не повторяй вслепую`);
      }
      // invoke бросает ДО инжекции (паттерн не поддержан / элемент пропал) — повтор физическим кликом законен.
      log.debug("act: invoke не удался — физический клик", msg(e));
      const r = await physicalClick(f, p, {});
      return { ...r, did: `${r.did} (UIA invoke не поддержан: ${msg(e).slice(0, 80)})` };
    }
  }
  return physicalClick(f, p, {});
}

/** type: сфокусировать поле кликом (лестница input.click), затем печать. Клик ушёл, печать упала → ActPartialError. */
async function doType(f: FoundTarget, p: ActParams): Promise<ActDone> {
  const text = p.text ?? "";
  const target = f.handle ? ({ by: "handle", handle: f.handle } as const) : f.point ? ({ by: "coords", x: f.point.x, y: f.point.y, space: "screen" } as const) : null;
  if (!target) throw new Error(`«${f.name}»: некуда кликнуть перед печатью (нет handle/точки)`);
  const r = await click(target, p.physical ? "physical" : "silent", p.restoreCursor);
  try {
    // Ревью 2026-09-24 (H-T1): длинный текст — вставкой, иначе печать выходит за бюджет act и повторяется моделью.
    if (text.length >= PASTE_FROM_CHARS) await pasteText(text);
    else await typeText(text);
  } catch (e) {
    if (e instanceof DrawingOverlayError) throw e;
    throw new ActPartialError(`клик в «${f.name}» ушёл, печать не удалась: ${msg(e)} — исход неизвестен, не повторяй вслепую`);
  }
  return { did: `напечатал ${text.length} симв. в «${f.name}»`, screenX: r?.screenX, screenY: r?.screenY, physical: Boolean(p.physical) };
}

/** UIA-паттерн по handle (set/toggle/select/expand): без handle честно нельзя — паттерны только у элементов. */
async function doPattern(f: FoundTarget, pattern: "setValue" | "toggle" | "select" | "expand", value?: string): Promise<ActDone> {
  if (!f.handle) throw new Error(`«${f.name}»: для ${pattern} нужен UIA-элемент (handle), а найдена только точка на экране`);
  await invoke({ by: "handle", handle: f.handle }, pattern, value);
  return { did: pattern === "setValue" ? `установил значение «${(value ?? "").slice(0, 40)}» в «${f.name}»` : `${pattern} «${f.name}»`, physical: false };
}

/** Выполнить глагол над целью. found не нужен только для key. */
export async function performAct(found: FoundTarget | undefined, verb: ActVerb, p: ActParams): Promise<ActDone> {
  if (verb === "key") {
    if (!p.combo) throw new Error("do:key без combo");
    await pressKey(p.combo);
    return { did: `нажал «${p.combo}»`, physical: true };
  }
  if (!found) throw new Error(`do:${verb} без цели (target)`);
  switch (verb) {
    case "click":
      return doClick(found, p);
    case "double":
      return physicalClick(found, p, { count: 2 });
    case "right":
      return physicalClick(found, p, { button: "right" });
    case "type":
      if (!p.text) throw new Error("do:type без text");
      return doType(found, p);
    case "set":
      if (!p.text) throw new Error("do:set без text (очистка поля — отдельное явное намерение)");
      return doPattern(found, "setValue", p.text);
    case "toggle":
    case "select":
    case "expand":
      return doPattern(found, verb);
    default: {
      const _x: never = verb;
      throw new Error(`неизвестный глагол act: ${String(_x)}`);
    }
  }
}
