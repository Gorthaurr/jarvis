/**
 * W2 (пакет 0): шов «отправить команду с одобрением §14». Пока — проброс в `session.sendAction`.
 *
 * Контракт для П3 (S-2, №5, №16): клиентский рубеж ответил `denied` + `data.needsApproval` и ничего не инжектировал →
 * сервер сам строит вопрос (категорию пересчитывает по процессу, строки с экрана чистит), после «да» — ОДИН повтор с
 * грантом и hwnd; `skill.execute` со `stepIndex` k > 0 → повтор только `steps.slice(k)`; `stepActionInjected` →
 * `uncertain` без повтора; отказ владельца → `gateDeclined`; повторный needsApproval → честная ошибка.
 * Готовый ToolResult (`{tool}`) отдаётся ДО `actResult`; код `denied` actResult не трогает.
 *
 * Зовут: generic-путь `dispatchTool`, `skill_execute` и `input_batch` (handlers/skills.ts). Владелец после P0 — П3.
 */
import type { ActionCommand, ActionResult } from "@jarvis/protocol";
import type { ToolContext, ToolResult } from "./dispatch.js";

export type ApprovedSend = { result: ActionResult } | { tool: ToolResult };

export async function sendActionApproved(ctx: ToolContext, cmd: ActionCommand, timeoutMs: number): Promise<ApprovedSend> {
  return { result: await ctx.session.sendAction(cmd, timeoutMs) };
}
