/**
 * Хендлеры НАВЫКОВ (§8 HERMES) — вынесено из god-object dispatch.ts (§ревью).
 * skill_list/execute/save/promote: каталог + реплей по id (со слотами) + сохранение процедуры + промоут в общую.
 * Маршрутизация остаётся в dispatch (switch).
 */
import { DEFAULT_ACTION_TIMEOUT_MS } from "@jarvis/protocol";
import { fillSlots } from "../../../memory/skill-slots.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";

/** Каталог выученных навыков для модели (id, имя, версия). */
export async function skillList(ctx: ToolContext): Promise<ToolResult> {
  const list = (await ctx.skills?.list(ctx.userId)) ?? [];
  if (list.length === 0) return ok("Выученных навыков пока нет.");
  return ok(
    list
      .map((s) => {
        const slots = s.slots?.length ? ` [переменные: ${s.slots.join(", ")}]` : "";
        return `- ${s.id}: «${s.name}» v${s.version}${s.needsReview ? " (требует подтверждения)" : ""}${slots}`;
      })
      .join("\n"),
  );
}

/** Запустить навык по id: сервер резолвит шаги/версию → эмитит skill.execute клиенту (§8). */
export async function skillExecute(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.skills) return err("навыки недоступны (нет провайдера)");
  const skillId = String(input.skillId ?? "").trim();
  if (!skillId) return err("skill_execute: нужен skillId (из skill_list)");
  const skill = await ctx.skills.get(ctx.userId, skillId);
  if (!skill) return err(`навык «${skillId}» не найден`);
  // Навык с guard-шагами (отправка/заказ/код) — подтверждение перед запуском (§14).
  if (skill.needsReview) {
    if (!ctx.confirm) return err(`навык «${skillId}» содержит необратимые шаги — нужно подтверждение (§14), но канал недоступен`);
    const { approved } = await ctx.confirm(`Запустить навык «${skillId}»? Он содержит необратимые шаги.`, "irreversible");
    if (!approved) return ok(`Отменено пользователем (навык ${skillId}).`);
  }
  const params = input.params && typeof input.params === "object" ? (input.params as Record<string, unknown>) : {};
  // §8 параметризация: подставить переменные {{slot}} в шаги ДО исполнения. Честность: если навык
  // ссылается на слоты, которых нет в params — НЕ исполняем (иначе актуатор получит литерал «{{contact}}»),
  // а просим модель дозаполнить. Литеральный навык (без слотов) проходит как есть.
  const { steps, missing } = fillSlots(skill.steps, params);
  if (missing.length > 0) {
    return err(`навык «${skillId}»: не заполнены переменные ${missing.map((m) => `{{${m}}}`).join(", ")} — передай их значения в params.`);
  }
  const result = await ctx.session.sendAction(
    { kind: "skill.execute", skillId: skill.id, version: skill.version, steps, params },
    DEFAULT_ACTION_TIMEOUT_MS,
  );
  if (result.ok) return ok(result.data !== undefined ? JSON.stringify(result.data) : `Навык «${skillId}» выполнен.`);
  return err(`Навык «${skillId}» не выполнен: ${result.error?.code ?? "runtime"} ${result.error?.message ?? ""}`);
}

/**
 * Сохранить выученный навык-процедуру (§8 HERMES): Джарвис сам пишет памятку {name, when, procedure} после
 * того, как разобрался со сложной задачей. НЕ реплей — навык recall'ится как текст-руководство в начале похожей
 * задачи. Повторное сохранение того же имени — новая версия (улучшение, + мульти-демо дистилляция).
 */
export async function skillSave(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.skills) return err("сохранение навыков недоступно (нет провайдера)");
  const name = String(input.name ?? "").trim();
  const when = String(input.when ?? "").trim();
  const procedure = String(input.procedure ?? "").trim();
  if (!name || !procedure) return err("skill_save: нужны name и procedure");
  const saved = await ctx.skills.save(ctx.userId, { name, when, procedure });
  if (!saved) return err("не удалось сохранить навык");
  const out = ok(`Навык «${saved.name}» сохранён (v${saved.version}). В следующий раз применю его сам.`);
  out.data = { id: saved.id }; // §8 МАКРОС: agent-петля дописывает в свежесохранённый навык авто-реплей жестов
  return out;
}

/**
 * Поднять СВОЙ выученный навык в ОБЩУЮ библиотеку (§мультитенант): после этого приём виден всем через recall.
 * Поднимаем только свои выученные процедуры (owner-check + не реплей).
 */
export async function skillPromote(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.skills?.promote) return err("повышение навыков недоступно (нет провайдера)");
  const skillId = String(input.skillId ?? "").trim();
  if (!skillId) return err("skill_promote: нужен skillId (из skill_list)");
  const r = await ctx.skills.promote(ctx.userId, skillId);
  if (r.ok) return ok(`Навык «${r.name}» теперь в общей библиотеке — им смогут пользоваться все.`);
  const reason =
    r.reason === "not_found"
      ? `навык «${skillId}» не найден среди твоих`
      : r.reason === "not_learned"
        ? "в общую библиотеку можно поднять только выученную процедуру (не записанный показом реплей)"
        : r.reason === "already_shared"
          ? "это уже общий навык"
          : "не удалось поднять навык в общую библиотеку";
  return err(reason);
}
