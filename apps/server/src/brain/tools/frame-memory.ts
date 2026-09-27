/**
 * W2 П5 «Кадры» (решение №6): координаты модели ВСЕГДА относятся к кадру ЗАДАЧИ, который она видела.
 *
 * `noteFrame` (ВНУТРИ dispatchTool — так кадр шага `capture` серии act{steps} виден следующим шагам) запоминает
 * последний ПОЛНЫЙ кадр задачи в WeakMap по ToolContext (петля создаёт его один на задачу): у двух задач — свои кадры,
 * глобального «последнего снимка» нет. Полный кадр — screen_capture без rect (f) или OCR, отдавший строки в своём
 * o-кадре (кадра задачи не было или он с другого монитора: следующий клик по строке — в нём). Зум (z) и выделение (s)
 * кадром задачи не становятся: модель кликает по ним с явным frame, который ей называет ответ.
 *
 * `withTaskFrame` подставляет `frame`, ТОЛЬКО если модель его не указала: coords у act (target, to), input_click,
 * input_mouse, шаги input_batch; rect у screen_capture, look{text}, wait_for{text}, screen_probe; система вывода
 * OCR и bbox look{elements}. Координат без кадра нет → честный отказ «сначала screen_capture» ДО гейтов и клиента
 * (берст не исполнится наполовину). Вход не мутируется (объект ToolUse подписки сверяется по JSON).
 */
import type { ToolContext, ToolResult } from "./dispatch.js";
import { err } from "./dispatch-util.js";

type Obj = Record<string, unknown>;

const frames = new WeakMap<object, string>();
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hasFrame = (o: Obj): boolean => typeof o.frame === "string" && o.frame !== "";
const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

export const NEED_FRAME =
  "координаты без кадра: сначала screen_capture (или look{what:'text'}) — x/y берутся с картинки кадра задачи; ничего не сделано.";

/** Кадр задачи (последний полный), если есть. */
export const taskFrameOf = (ctx: ToolContext): string | undefined => frames.get(ctx as object);

/** Проставить кадр в объект координат (новая копия); кадра задачи нет → null (нужен отказ). */
function framed(o: Obj, frame: string | undefined): Obj | null {
  if (hasFrame(o)) return o;
  return frame ? { ...o, frame } : null;
}

/** Точечная цель act (объект с x/y). */
const pointTarget = (t: unknown): t is Obj => isObj(t) && isNum(t.x) && isNum(t.y);
const mouseHasPoint = (o: Obj): boolean => (isNum(o.x) && isNum(o.y)) || (isNum(o.toX) && isNum(o.toY));

/** Шаги input_batch: coords-цели и мышь с точкой. */
function batchSteps(steps: unknown, frame: string | undefined): unknown[] | null {
  if (!Array.isArray(steps)) return null;
  const out: unknown[] = [];
  for (const s of steps) {
    if (!isObj(s)) {
      out.push(s);
      continue;
    }
    let step: Obj = s;
    if (isObj(s.target) && s.target.by === "coords") {
      const t = framed(s.target, frame);
      if (!t) return null;
      step = { ...step, target: t };
    }
    if (s.action === "input.mouse" && isObj(s.params) && mouseHasPoint(s.params)) {
      const p = framed(s.params, frame);
      if (!p) return null;
      step = { ...step, params: p };
    }
    out.push(step);
  }
  return out;
}

/** base с полем key = v (копия); v === null (кадра нет) → null. */
const put = (base: Obj | null, key: string, v: Obj | unknown[] | null): Obj | null => (base && v ? { ...base, [key]: v } : null);

/** Подставить кадр задачи; координаты без кадра и кадра нет → `denied` (честный отказ до гейтов). */
export function withTaskFrame(name: string, input: Obj, ctx: ToolContext): { input: Obj; denied?: ToolResult } {
  const frame = taskFrameOf(ctx);
  let out: Obj | null = input;
  switch (name) {
    case "act":
      if (pointTarget(input.target)) out = put(out, "target", framed(input.target, frame));
      if (pointTarget(input.to)) out = put(out, "to", framed(input.to, frame));
      break;
    case "input_click":
      if (isObj(input.target) && input.target.by === "coords") out = put(out, "target", framed(input.target, frame));
      break;
    case "input_mouse":
      if (mouseHasPoint(input)) out = framed(input, frame);
      break;
    case "screen_capture":
    case "screen_probe":
    case "screen_read_text":
      if (isObj(input.rect)) out = put(out, "rect", framed(input.rect, frame));
      if (out && name === "screen_read_text" && frame && !hasFrame(out)) out = { ...out, frame }; // система вывода строк
      break;
    case "ui_snapshot":
      if (frame && !hasFrame(input)) out = { ...input, frame }; // система bbox; без кадра — без bbox
      break;
    case "wait_for": {
      const c = input.condition;
      if (isObj(c) && c.kind === "text" && isObj(c.rect)) out = put(out, "condition", put(c, "rect", framed(c.rect, frame)));
      break;
    }
    case "input_batch":
      if (Array.isArray(input.steps)) out = put(out, "steps", batchSteps(input.steps, frame));
      break;
  }
  return out ? { input: out } : { input, denied: err(`${name}: ${NEED_FRAME}`) };
}

/** Запомнить полный кадр задачи из успешного результата (f у screen_capture; o у OCR, отдавшего строки в своём кадре). */
export function noteFrame(name: string, out: ToolResult, ctx: ToolContext): void {
  if (out.isError || !isObj(out.data)) return;
  const d = out.data;
  if (typeof d.frameId !== "string" || !d.frameId) return;
  if (name === "screen_capture" && d.zoom !== true) frames.set(ctx as object, d.frameId);
  else if (name === "screen_read_text" && d.frame === undefined) frames.set(ctx as object, d.frameId);
}
