/**
 * W2 (пакет 0): маршрут серии `act{steps}` — стоит в `dispatchTool` ДО гейтов: каждый шаг пройдёт `dispatchTool("act")`
 * со всеми гейтами сам (двойного вопроса владельцу нет). Пока — честный отказ, ничего не исполняется.
 *
 * Контракт для П4: проверки (≤ ACT_STEPS_MAX, вложенных steps нет, do ∈ ACT_VERBS ∪ capture ∪ wait ≤ 5000 мс, app —
 * общий); шаг → `dispatch("act", …)` с `observe:false` для промежуточных, `capture` → `dispatch("screen_capture")`;
 * стоп на первом isError/uncertain/declined/overlayDenied/channelDown/veiled; «k из n» + partialSteps и ВСЕ флаги
 * наружу; ≤ 2 картинки; `ctx.isCancelled()` между шагами; бюджет ~180 с.
 *
 * Владелец после P0 — П4.
 */
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err } from "../dispatch-util.js";

/** Рекурсивный вход в dispatchTool (внедряется, чтобы модуль не импортировал диспетчер по кругу). */
export type DispatchFn = (name: string, input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

/** Вызов — серия act{steps}? */
export function isActSteps(name: string, input: Record<string, unknown>): boolean {
  return name === "act" && input.steps !== undefined;
}

export async function actSteps(_ctx: ToolContext, _input: Record<string, unknown>, _dispatch: DispatchFn): Promise<ToolResult> {
  return err("act{steps}: серии шагов пока не исполняются — ничего не сделано; вызови act по одному шагу.");
}
