/**
 * Интеграция W2 (п.5): ОДИНОЧНАЯ команда упала ПОСЛЕ того, как часть действия ушла в GUI (`stepActionInjected`), и
 * вопроса владельцу нет: §0 посреди печати, своё окно перехватило фокус, сбой сайдкара после клика в поле. Это не
 * «не сделано» (повтор = дубль набранного), а «исход неизвестен»: `uncertain`, журнал чекпойнта велит сверить.
 * Раньше такой `denied` уходил в generic-ветку dispatch («Действие … не удалось: denied») — журнал писал «ОШИБКА».
 *
 * Соседи: отказ С needsApproval и ушедшей частью — send-approved.ts (injectedOutcome); вуаль — overlayDeniedResult;
 * серии (skill.execute) — handlers/skills.ts; таймаут act — handlers/act.ts.
 */
import type { ActionResult } from "@jarvis/protocol";
import { err } from "./dispatch-util.js";
import type { ToolResult } from "./dispatch.js";

export function injectedFailure(label: string, r: Pick<ActionResult, "ok" | "error" | "stepActionInjected">): ToolResult | null {
  if (r.ok || r.stepActionInjected !== true || r.error?.code === "overlay_drawing") return null;
  const why = r.error?.message || r.error?.code || "сбой";
  const out = err(`${label}: ${why} ИСХОД НЕИЗВЕСТЕН — часть действия УЖЕ ушла в GUI: не повторяй вслепую (дубль), сверь состояние (look).`);
  out.uncertain = true;
  return out;
}
