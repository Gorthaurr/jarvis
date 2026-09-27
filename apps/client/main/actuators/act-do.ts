/**
 * W4 «Руки» (2026-09-10): ДЕЙСТВИЕ примитива gui.act над найденной целью.
 *
 * Правило честности, ради которого модуль отдельный: ПОВТОР ТОЛЬКО ЕСЛИ НИЧЕГО НЕ УШЛО. UIA invoke по handle либо
 * срабатывает, либо бросает ДО действия (паттерн не поддержан / элемент пропал) — тогда законен физический клик по тому
 * же handle. Если действие ушло (invoke вернул ok, печать началась), второй попытки нет ни здесь, ни по провалу verify.
 * Бесшумный путь (UIA) — по умолчанию; физический SendInput — фолбэк, physical:true, правый/двойной клик и точка без
 * UIA-элемента. type = клик в поле + печать (W2: clear/enter — act-do-text.ts); set = UIA setValue (без клавиатуры);
 * W2: triple/middle/hover/scroll/drag — act-do-pointer.ts.
 */
import { createLogger } from "@jarvis/shared";
import type { ActCommand } from "./act-args.js";
import { doPointer } from "./act-do-pointer.js";
import { doType, doTypeFocused } from "./act-do-text.js";
import { DrawingOverlayError } from "../selection/overlay-error.js";
import type { FoundTarget } from "./act-find.js";
import { actionErrorOf } from "./action-error.js";
import { physicalRectToDip } from "./coords.js";
import { invoke } from "./ground.js";
import { click, pressKey } from "./input.js";
import { invokableAtPoint } from "./point-policy.js";

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

/** Часть действия УЖЕ УШЛА (клик в поле прошёл, печать упала): stepActionInjected, «исход неизвестен», без повтора. */
export class ActPartialError extends Error {
  readonly actionCode = "runtime" as const; // W2: общий catch dispatch (action-error.ts) ставит stepActionInjected
  readonly injected = true;
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
export async function physicalClick(f: FoundTarget, p: ActParams, opts: { button?: "left" | "right" | "middle"; count?: number }): Promise<ActDone> {
  const target = f.point
    ? ({ by: "coords", x: f.point.x, y: f.point.y, space: "screen" } as const)
    : f.handle
      ? ({ by: "handle", handle: f.handle } as const)
      : null;
  if (!target) throw new Error(`«${f.name}»: ни handle, ни точки — кликнуть физически нечем`);
  const r = await click(target, "physical", p.restoreCursor, opts);
  const n = opts.count ?? 1;
  const how = opts.button === "right" ? "правый клик" : opts.button === "middle" ? "средний клик" : n >= 3 ? "тройной клик" : n > 1 ? "двойной клик" : "физический клик";
  return { did: `${how} по «${f.name}»`, screenX: r?.screenX, screenY: r?.screenY, physical: true };
}

/** G-10 (как input_click): цель-ТОЧКА invoke'ится только малым элементом (строка 400×64 с «×» — клик в точку). */
const invokeFits = (f: FoundTarget): boolean => !f.point || invokableAtPoint(f.bbox ? physicalRectToDip(f.bbox) : undefined);

/** click: UIA invoke по handle; бросил ДО действия → физический клик по тому же handle; точка без handle → физический. */
async function doClick(f: FoundTarget, p: ActParams): Promise<ActDone> {
  if (f.handle && !p.physical && invokeFits(f)) {
    try {
      await invoke({ by: "handle", handle: f.handle }, "invoke");
      return { did: `UIA invoke «${f.name}»`, physical: false };
    } catch (e) {
      if (e instanceof DrawingOverlayError) throw e;
      // W2: отказ рубежа — вердикт, не «invoke не поддержан»: фолбэк судился бы вторично по другим фактам (точка).
      if (actionErrorOf(e)?.code === "denied") throw e;
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

/** UIA-паттерн по handle (set/toggle/select/expand): без handle честно нельзя — паттерны только у элементов. */
async function doPattern(f: FoundTarget, pattern: "setValue" | "toggle" | "select" | "expand", value?: string): Promise<ActDone> {
  if (!f.handle) throw new Error(`«${f.name}»: для ${pattern} нужен UIA-элемент (handle), а найдена только точка на экране`);
  await invoke({ by: "handle", handle: f.handle }, pattern, value);
  return { did: pattern === "setValue" ? `установил значение «${(value ?? "").slice(0, 40)}» в «${f.name}»` : `${pattern} «${f.name}»`, physical: false };
}

/** Выполнить глагол команды над целью. found не нужен только для key (и type без цели). W2: вход — команда целиком. */
export async function performAct(found: FoundTarget | undefined, cmd: ActCommand, opts: { restoreCursor: boolean }): Promise<ActDone> {
  const verb = cmd.do ?? "click";
  const p: ActParams = { text: cmd.text, combo: cmd.combo, physical: cmd.physical, restoreCursor: opts.restoreCursor };
  if (verb === "key") {
    if (!p.combo) throw new Error("do:key без combo");
    await pressKey(p.combo);
    return { did: `нажал «${p.combo}»`, physical: true };
  }
  if (verb === "type" && !found) {
    if (!p.text) throw new Error("do:type без text");
    return doTypeFocused(cmd, p);
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
      return doType(found, cmd, p);
    case "set":
      if (!p.text) throw new Error("do:set без text (очистка поля — отдельное явное намерение)");
      return doPattern(found, "setValue", p.text);
    case "toggle":
    case "select":
    case "expand":
      return doPattern(found, verb);
    case "triple": case "middle": case "hover": case "drag": case "scroll":
      return doPointer(found, verb, cmd, p); // W2: глаголы указателя (act-do-pointer.ts)
    default: {
      const _x: never = verb;
      throw new Error(`неизвестный глагол act: ${String(_x)}`);
    }
  }
}
