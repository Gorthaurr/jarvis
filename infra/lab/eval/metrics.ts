/**
 * Что делал сервер за окно прогона: раунды модели и имена инструментов (клиент видит только виды команд, а серверные
 * memory_write / set_reminder до него не доходят). Прогоны последовательны, поэтому окно времени однозначно.
 */
import { ACTUATOR_TOOL_BY_KIND } from "../../../packages/tools/src/index.js";
import type { LabServer, TurnResult } from "../lib/contracts.js";

export interface Activity {
  rounds: number;
  tools: string[];
}

export function serverActivity(server: LabServer, fromMs: number, toMs: number, turns: readonly TurnResult[]): Activity {
  const tools = new Set<string>();
  let rounds = 0;
  try {
    for (const row of server.metrics()) {
      const at = Date.parse(String(row.ts ?? ""));
      if (row.type !== "round" || !(at >= fromMs && at <= toMs + 1_000)) continue;
      rounds += 1;
      for (const t of Array.isArray(row.toolNames) ? row.toolNames : []) tools.add(String(t));
    }
  } catch {
    /* метрик нет (заглушка/сервер упал) — остаются инструменты по командам клиента */
  }
  // Запасной источник (ход закрыл tier0 без модели или метрик нет): виды команд, дошедшие до клиента → инструменты.
  if (tools.size === 0) for (const t of turns) for (const a of t.actions) tools.add((ACTUATOR_TOOL_BY_KIND as Record<string, string>)[a.cmd.kind] ?? a.cmd.kind);
  return { rounds, tools: [...tools] };
}
