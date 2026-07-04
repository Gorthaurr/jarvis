/**
 * Хендлеры НАПОМИНАНИЙ (§9) — вынесено из god-object dispatch.ts (§ревью).
 * durable-таймер + проактивная озвучка по таймеру. set/cancel/list. Маршрутизация остаётся в dispatch (switch).
 */
import { describeWhen, resolveFireAt } from "../../../proactive/reminders/reminder.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";

export async function setReminder(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.reminders || !ctx.sessionId) return err("Напоминания сейчас недоступны (нет канала озвучки).");
  const text = String(input.text ?? "").trim();
  if (!text) return err("set_reminder: пустой text — нечего напоминать.");
  const res = resolveFireAt(
    { delaySeconds: input.delay_seconds as number | undefined, at: input.at as string | undefined },
    Date.now(),
  );
  if ("error" in res) return err(res.error);
  const r = ctx.reminders.add({ sessionId: ctx.sessionId, userId: ctx.userId, text, fireAt: res.fireAt });
  return ok(`Напоминание поставлено (${describeWhen(r.fireAt, Date.now())}): «${text}». id=${r.id}`);
}

export async function cancelReminder(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.reminders) return err("Напоминания сейчас недоступны.");
  const query = String(input.query ?? "").trim();
  if (!query) return err("cancel_reminder: пустой query.");
  const cancelled = ctx.reminders.cancel(query, ctx.sessionId);
  return cancelled
    ? ok(`Отменил напоминание: «${cancelled.text}».`)
    : err(`Не нашёл активного напоминания по «${query}».`);
}

export function listReminders(ctx: ToolContext): ToolResult {
  if (!ctx.reminders) return err("Напоминания сейчас недоступны.");
  const items = ctx.reminders.list(ctx.sessionId);
  if (items.length === 0) return ok("Активных напоминаний нет.");
  const now = Date.now();
  const lines = items.map((r) => `• ${describeWhen(r.fireAt, now)}: «${r.text}» (id=${r.id})`);
  return ok(`Активные напоминания:\n${lines.join("\n")}`);
}
