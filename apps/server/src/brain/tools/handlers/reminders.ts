/**
 * Хендлеры НАПОМИНАНИЙ (§9) — вынесено из god-object dispatch.ts (§ревью).
 * durable-таймер + проактивная озвучка по таймеру. set/cancel/list. Маршрутизация остаётся в dispatch (switch).
 */
import { describeRepeat, describeWhen, parseRepeat, resolveFireAt } from "../../../proactive/reminders/reminder.js";
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
  // Волна D: ПОВТОР («напоминай каждый день пить таблетки»). repeat_seconds имеет приоритет над repeat
  // (числовой интервал конкретнее словесного ритма); ошибка разбора — честный отказ, не тихий одноразовый.
  // СЫРОЕ значение, без Number(): модель часто шлёт необязательное поле как null, а Number(null)=0 →
  // parseRepeat видел «интервал 0 секунд» и возвращал ошибку → обычное ОДНОРАЗОВОЕ напоминание не
  // создавалось вовсе (ревью волны D). null/"" внутри parseRepeat трактуются как «повтора нет».
  // Sentinel-значения необязательного поля («», 0, null) = «повтора нет», а НЕ «интервал 0 секунд»:
  // иначе обычное одноразовое напоминание не создавалось бы вовсе (контроль волны D).
  const rs = input.repeat_seconds;
  const repRaw = rs === undefined || rs === null || rs === "" || rs === 0 ? input.repeat : Number(rs);
  const rep = parseRepeat(repRaw);
  if ("error" in rep) return err(`set_reminder: ${rep.error}`);
  const r = ctx.reminders.add({ sessionId: ctx.sessionId, userId: ctx.userId, text, fireAt: res.fireAt, repeat: rep.repeat });
  // Цитируем ЗАПИСЬ (r.text/r.repeat), а не входящий текст: при схлопывании в уже существующее
  // напоминание модель иначе подтвердила бы владельцу формулировку и ритм, которых в сторе нет
  // (в назначенный момент прозвучит другое) — masked failure (контроль волны D).
  const rhythm = describeRepeat(r.repeat);
  const when = describeWhen(r.fireAt, Date.now());
  if (r.created === false) {
    return ok(`Это уже запланировано (${when}${rhythm ? `, ${rhythm}` : ""}): «${r.text}». Второе напоминание не ставил. id=${r.id}`);
  }
  return ok(`Напоминание поставлено (${when}${rhythm ? `, далее ${rhythm}` : ""}): «${r.text}». id=${r.id}`);
}

export async function cancelReminder(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.reminders) return err("Напоминания сейчас недоступны.");
  const query = String(input.query ?? "").trim();
  if (!query) return err("cancel_reminder: пустой query.");
  // По ВЛАДЕЛЬЦУ, не по сессии: sessionId меняется на переподключении, и отмена переставала работать.
  const cancelled = ctx.reminders.cancel(query, ctx.userId);
  return cancelled
    ? ok(`Отменил напоминание: «${cancelled.text}».`)
    : err(`Не нашёл активного напоминания по «${query}».`);
}

export function listReminders(ctx: ToolContext): ToolResult {
  if (!ctx.reminders) return err("Напоминания сейчас недоступны.");
  const items = ctx.reminders.list(ctx.userId);
  if (items.length === 0) return ok("Активных напоминаний нет.");
  const now = Date.now();
  const lines = items.map((r) => {
    const rhythm = describeRepeat(r.repeat);
    return `• ${describeWhen(r.fireAt, now)}${rhythm ? ` (${rhythm})` : ""}: «${r.text}» (id=${r.id})`;
  });
  return ok(`Активные напоминания:\n${lines.join("\n")}`);
}
