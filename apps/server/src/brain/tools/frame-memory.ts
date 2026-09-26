/**
 * W2 (пакет 0): шов «кадр задачи» (решение №6). Пока — тождество и пустая запись.
 *
 * Контракт для П5: `noteFrame` (зовётся ВНУТРИ dispatchTool — так кадр шага `capture` в act{steps} виден следующим
 * шагам) запоминает последний ПОЛНЫЙ кадр ЗАДАЧИ в WeakMap по ToolContext (у двух задач — свои кадры, глобального
 * «последнего кадра» нет). `withTaskFrame` подставляет `frame`, ТОЛЬКО если модель его не указала: coords у act,
 * input_click, input_mouse; rect у screen_capture, look, wait_for, probe; шаги input_batch; OCR-команды (система
 * вывода). Кадра нет → честное «сначала screen_capture».
 *
 * Владелец после P0 — П5.
 */
import type { ToolContext, ToolResult } from "./dispatch.js";

/** Подставить кадр задачи в координаты входа. P0: вход как есть. */
export function withTaskFrame(_name: string, input: Record<string, unknown>, _ctx: ToolContext): Record<string, unknown> {
  return input;
}

/** Запомнить кадр из результата инструмента (screen_capture и т.п.). P0: ничего. */
export function noteFrame(_name: string, _out: ToolResult, _ctx: ToolContext): void {
  /* П5 */
}
