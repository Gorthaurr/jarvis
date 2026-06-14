/**
 * Грундинг и UIA-паттерны через win-сайдкар (§6).
 *
 * Замковый камень (§6): цель резолвится по РОЛИ/ИМЕНИ в a11y-дереве (UIAutomation),
 * не по пикселям/DOM. ui.ground → handle+bbox; ui.invoke действует по handle через
 * UIA-паттерн (Invoke/SetValue/Select/Toggle/Expand/Scroll) БЕЗ захвата курсора и
 * фокуса — юзер продолжает работать, пока Джарвис действует в фоновом окне.
 *
 * Реальная UIA — в сайдкаре apps/sidecar-win (C#/.NET); связь по stdio JSON-RPC.
 * Если сайдкар не поднят — NotImplementedError (dispatch → runtime-ошибка).
 */
import type { Target, UiPattern } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { NotImplementedError } from "./input.js";
import { sidecar } from "./sidecar-client.js";

const log = createLogger("actuator:ground");

/** Результат ui.ground — в ActionResult.data (§5: {handle, bbox}). */
export interface GroundResult {
  handle: string;
  bbox: { x: number; y: number; w: number; h: number };
}

function ensure(): void {
  if (!sidecar().ready) throw new NotImplementedError("сайдкар UIA не запущен");
}

/** Найти элемент по роли/имени в активном окне (a11y-first, §6). */
export async function ground(query: { role: string; name?: string }): Promise<GroundResult> {
  ensure();
  log.debug("ui.ground", query);
  const data = (await sidecar().request("ground", { role: query.role, name: query.name })) as GroundResult;
  return data;
}

/** Действие по UIA-паттерну над целью (основной путь, §6). Сайдкар действует по handle. */
export async function invoke(target: Target, pattern: UiPattern, value?: string): Promise<void> {
  ensure();
  log.debug("ui.invoke", { pattern });
  let handle: string;
  if (target.by === "handle") handle = target.handle;
  else if (target.by === "role") handle = (await ground({ role: target.role, name: target.name })).handle;
  else throw new NotImplementedError("ui.invoke по координатам невозможен — нужен a11y-handle");
  await sidecar().request("invoke", { handle, pattern, value });
}

/** Прочитать выделение/окно (дейксис §19) через сайдкар (TextPattern / a11y-выжимка). */
export async function readContext(scope: "selection" | "active_window" | "screen"): Promise<string> {
  ensure();
  // selection → TextPattern.GetSelection; active_window/screen → выжимка видимой области (§19).
  const op = scope === "selection" ? "read.selection" : "read.window";
  const data = (await sidecar().request(op, {})) as { text?: string };
  return data.text ?? "";
}
