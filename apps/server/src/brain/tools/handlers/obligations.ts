/**
 * Хендлеры ОБЯЗАТЕЛЬСТВ/СЧЕТОВ (§проактив-всё) — durable-список дат, который ambient-движок проактивно
 * напоминает заранее и в день оплаты. add/remove/list. Маршрутизация — в dispatch (switch).
 */
import { makeObligation, upcomingDue } from "../../../proactive/ambient/obligations.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

export function obligationAdd(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  if (!ctx.obligations) return err("Обязательства сейчас недоступны.");
  const what = String(input.what ?? "").trim();
  if (!what) return err("obligation_add: нужно what (что оплатить/сделать).");
  const dueStr = String(input.due ?? "").trim();
  const dueParsed = dueStr ? Date.parse(dueStr) : Number.NaN;
  if (dueStr && !Number.isFinite(dueParsed)) return err("obligation_add: не разобрал дату due (нужен ISO, напр. 2026-07-15).");
  const dayRaw = Number(input.day_of_month);
  const recurringDay = Number.isFinite(dayRaw) && dayRaw >= 1 && dayRaw <= 28 ? Math.floor(dayRaw) : undefined;
  const o = makeObligation({
    userId: ctx.userId,
    what,
    amount: input.amount ? String(input.amount) : undefined,
    dueAt: Number.isFinite(dueParsed) ? dueParsed : undefined,
    recurringDay,
    now: Date.now(),
  });
  if (!o) return err("obligation_add: укажи срок — due (разовое, ISO-дата) ИЛИ day_of_month (ежемесячное, 1..28).");
  ctx.obligations.add(o);
  const when = o.recurringDay ? `каждое ${o.recurringDay}-е число` : `к ${fmtDate(upcomingDue(o, Date.now()) ?? Date.now())}`;
  return ok(`Запомнил${o.amount ? ` (${o.amount})` : ""}: ${o.what} — ${when}. Напомню заранее и в день оплаты. id=${o.id}`);
}

export function obligationRemove(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  if (!ctx.obligations) return err("Обязательства сейчас недоступны.");
  const q = String(input.query ?? "").trim();
  if (!q) return err("obligation_remove: пустой query.");
  const cancelled = ctx.obligations.cancel(q, ctx.userId);
  return cancelled ? ok(`Убрал: ${cancelled.what}.`) : err(`Не нашёл обязательства по «${q}».`);
}

export function obligationList(ctx: ToolContext): ToolResult {
  if (!ctx.obligations) return err("Обязательства сейчас недоступны.");
  const items = ctx.obligations.list(ctx.userId);
  if (items.length === 0) return ok("Запомненных счетов/обязательств нет.");
  const now = Date.now();
  const lines = items.map((o) => {
    const when = o.recurringDay ? `каждое ${o.recurringDay}-е` : `к ${fmtDate(upcomingDue(o, now) ?? now)}`;
    return `• ${o.what}${o.amount ? ` (${o.amount})` : ""} — ${when} (id=${o.id})`;
  });
  return ok(`Обязательства:\n${lines.join("\n")}`);
}
