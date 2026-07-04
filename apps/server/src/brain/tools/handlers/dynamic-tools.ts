/**
 * Хендлеры САМОПИСНЫХ инструментов (§8+ саморасширение) — вынесено из god-object dispatch.ts (§ревью).
 * tool_create/list/remove (реестр) + tool_load (§15 ленивая загрузка холодных схем). Исполнение самописного
 * (runDynamicTool → executeGuardedCode) остаётся в dispatch как мост к code.run. Маршрутизация — в dispatch.
 */
import { COLD_TOOL_NAMES, TOOLS_BY_NAME } from "@jarvis/tools";
import type { DynamicToolParam } from "../dynamic.js";
import type { ToolContext, ToolResult } from "../dispatch.js";
import { err, ok } from "../dispatch-util.js";

/** Создать/обновить самописный инструмент (валидируется именем/языком/гардом). */
export async function toolCreate(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.dynamicTools) return err("саморасширение недоступно (нет реестра инструментов)");
  const res = await ctx.dynamicTools.create(ctx.userId, {
    name: String(input.name ?? ""),
    description: String(input.description ?? ""),
    lang: String(input.lang ?? ""),
    code: String(input.code ?? ""),
    params: Array.isArray(input.params) ? (input.params as DynamicToolParam[]) : [],
  });
  if (!res.ok) return err(`tool_create: ${res.error}`);
  return ok(`Инструмент «${input.name}» создан и готов к вызову (как обычный инструмент на след. ходах).`);
}

export function toolList(ctx: ToolContext): ToolResult {
  const list = ctx.dynamicTools?.list(ctx.userId) ?? [];
  if (list.length === 0) return ok("Самописных инструментов пока нет.");
  return ok(list.map((t) => `- ${t.name} (${t.lang}): ${t.description}`).join("\n"));
}

export async function toolRemove(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.dynamicTools) return err("саморасширение недоступно");
  const removed = await ctx.dynamicTools.remove(ctx.userId, String(input.name ?? ""));
  return removed ? ok(`Инструмент «${input.name}» удалён.`) : err(`Инструмент «${input.name}» не найден.`);
}

/**
 * §15 ленивая загрузка: подгрузить ПОЛНЫЕ схемы холодных/внешних инструментов в набор (со следующего хода).
 * Валидные имена кладём в per-session activation; агент включит их схемы. Горячие — уже активны (no-op).
 * Неизвестные — честно сообщаем. Так модель сама расширяет себе арсенал без раздувания контекста.
 */
export function toolLoad(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  if (!ctx.toolActivation) return err("ленивая загрузка недоступна (нет реестра активации).");
  const names = Array.isArray(input.names) ? input.names.map((n) => String(n).trim()).filter(Boolean) : [];
  if (names.length === 0) return err("tool_load: нужен массив names инструментов из каталога.");
  const loaded: string[] = [];
  const already: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const known = Boolean(TOOLS_BY_NAME[name]) || Boolean(ctx.dynamicTools?.has(ctx.userId, name)) || Boolean(ctx.mcp?.has(name));
    if (!known) {
      unknown.push(name);
      continue;
    }
    // Горячий (не cold и не mcp) уже в наборе — активировать не нужно.
    if (TOOLS_BY_NAME[name] && !COLD_TOOL_NAMES.has(name)) {
      already.push(name);
      continue;
    }
    ctx.toolActivation.add(name);
    loaded.push(name);
  }
  const parts: string[] = [];
  if (loaded.length) parts.push(`Загружены (доступны со следующего хода): ${loaded.join(", ")}.`);
  if (already.length) parts.push(`Уже активны: ${already.join(", ")}.`);
  if (unknown.length) parts.push(`Не найдены в каталоге: ${unknown.join(", ")}.`);
  return loaded.length || already.length ? ok(parts.join(" ")) : err(parts.join(" ") || "tool_load: нечего загружать.");
}
