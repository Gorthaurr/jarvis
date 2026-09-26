/**
 * W2 (пакет 0): шов §14 для GUI-инструментов в `dispatchTool` (вынесен из dispatch.ts без изменения поведения).
 *
 * §14 ГЕЙТ НЕОБРАТИМЫХ КЛИКОВ (причина №4 USER_SCENARIOS_2026-09-02, commit-gate.ts): «Провести» в 1С, Enter в Telegram
 * Desktop/Discord, «Оплатить» в банк-клиенте — по процессу на переднем плане из живого снимка ПК (у act с `app` — по
 * программе из `app`: act сам фокусирует окно ПОСЛЕ гейта, H-S1). Отказ владельца → declined (петля не считает сделанным).
 *
 * Контракт вердикта: `denied` — готовый ToolResult (отказ/нет канала), команда не уходит; `approval` — гранты для
 * клиента (выдаёт П3); `commitApproved` — прежний флаг gui.act (удаляется в интеграции W2).
 */
import type { CommitApproval } from "@jarvis/protocol";
import { assessGuiCommit, parseForegroundProcess, uiHandleLabel } from "./commit-gate.js";
import { confirmDeclineText, err, gateDeclined } from "./dispatch-util.js";
import type { ToolContext, ToolResult } from "./dispatch.js";

export interface GuiGateVerdict {
  denied?: ToolResult;
  approval?: CommitApproval;
  commitApproved: boolean;
}

/** Инструменты, которые судит гейт GUI-коммитов. */
type GuiGatedTool = "ui_invoke" | "input_key" | "input_click" | "act" | "input_type";
const GUI_GATED: ReadonlySet<string> = new Set<GuiGatedTool>(["ui_invoke", "input_key", "input_click", "act", "input_type"]);
const isGated = (name: string): name is GuiGatedTool => GUI_GATED.has(name);

export async function guiGate(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<GuiGateVerdict> {
  if (!isGated(name)) return { commitApproved: false };
  const sessObj = ctx.session as unknown as object;
  const actApp = name === "act" && typeof input.app === "string" && input.app.trim() ? input.app.trim() : null;
  const actHandle = name === "act" && input.target && typeof input.target === "object" ? (input.target as { handle?: unknown }).handle : undefined;
  const risk = assessGuiCommit({
    foregroundProcess: parseForegroundProcess(ctx.systemContext?.() ?? ""),
    app: actApp,
    tool: name,
    input,
    label:
      name === "ui_invoke"
        ? uiHandleLabel(sessObj, input.handle)
        : name === "act"
          ? uiHandleLabel(sessObj, typeof actHandle === "string" ? Number(actHandle) : actHandle)
          : undefined,
  });
  if (!risk) return { commitApproved: false };
  if (!ctx.confirm) return { denied: err(`${name}: ${risk.summary} Нужно подтверждение владельца (§14), а канал недоступен.`), commitApproved: false };
  const gate = await ctx.confirm(`${risk.summary}\nПодтвердить?`, "irreversible");
  if (!gate.approved) return { denied: gateDeclined(confirmDeclineText(gate.outcome, `${risk.what} в ${risk.where}`), gate.outcome), commitApproved: false };
  return { commitApproved: true };
}
