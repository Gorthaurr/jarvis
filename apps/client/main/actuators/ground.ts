/**
 * Грундинг и UIA-паттерны через win-сайдкар (§6).
 *
 * Замковый камень (§6): цель действия резолвится по РОЛИ/ИМЕНИ в a11y-дереве (UI Automation),
 * а не по пикселям/DOM. ui.ground возвращает handle+bbox; ui.invoke действует по handle
 * через UIA-паттерн (InvokePattern/ValuePattern/...), БЕЗ захвата курсора и фокуса.
 *
 * Реальная работа с UIA — в нативном сайдкаре apps/sidecar-win (C#/.NET, System.Windows.Automation),
 * main общается с ним по IPC. Здесь — типизированный стаб контракта.
 *
 * // TODO(M3): поднять IPC к сайдкару, реализовать ground()/invoke().
 */
import type { Target, UiPattern } from "@jarvis/protocol";
import { createLogger } from "@jarvis/shared";
import { NotImplementedError } from "./input.js";

const log = createLogger("actuator:ground");

/** Результат ui.ground — попадает в ActionResult.data (§5: {handle, bbox}). */
export interface GroundResult {
  handle: string;
  bbox: { x: number; y: number; w: number; h: number };
}

/** Найти элемент по роли/имени в активном окне (a11y-first, §6). */
export async function ground(query: { role: string; name?: string }): Promise<GroundResult> {
  log.warn(`ui.ground(${query.role}/${query.name ?? "*"}) — сайдкар UIA не реализован (M3)`);
  throw new NotImplementedError("ui.ground");
}

/** Действие по UIA-паттерну над целью (основной путь, §6). */
export async function invoke(
  _target: Target,
  _pattern: UiPattern,
  _value?: string,
): Promise<void> {
  log.warn("ui.invoke — сайдкар UIA не реализован (M3)");
  throw new NotImplementedError("ui.invoke");
}
