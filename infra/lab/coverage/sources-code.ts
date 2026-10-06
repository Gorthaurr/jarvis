/**
 * Списки строк матрицы, собранные ИЗ КОДА: инструменты (схемы), виды ActionCommand (протокол), интенты tier0 (роутер).
 * Ничего не хардкодим — добавили инструмент/вид/интент, и он появляется в матрице «непокрытым», пока его не докажут.
 */
import { readFileSync } from "node:fs";
import { ACTUATOR_TOOL_BY_KIND, TOOL_SCHEMAS } from "../../../packages/tools/src/index.js";
import { repoRoot } from "../lib/deps.js";

export function collectTools(): string[] {
  return TOOL_SCHEMAS.map((t) => t.name).sort();
}

/**
 * Виды команд — ключи Record<ActionKind, string>: компилятор гарантирует исчерпывающее совпадение с протоколом
 * (packages/protocol/src/actions.ts), а regex по union зацепил бы вложенные `kind:` условий wait_for.
 */
export function collectActions(): string[] {
  return Object.keys(ACTUATOR_TOOL_BY_KIND).sort();
}

/** Срез `export type LocalIntent = ... ;` из роутера и все `kind: "…"` внутри него. */
export function parseIntentKinds(routerSource: string): string[] {
  const start = routerSource.indexOf("export type LocalIntent");
  if (start < 0) throw new Error("в router/index.ts нет `export type LocalIntent` — матрица интентов не собирается");
  const end = routerSource.indexOf(";\n", start);
  const block = routerSource.slice(start, end < 0 ? undefined : end);
  return [...new Set([...block.matchAll(/\bkind:\s*"([^"]+)"/gu)].map((m) => m[1]!))].sort();
}

export function collectIntents(): string[] {
  return parseIntentKinds(readFileSync(repoRoot("apps/server/src/brain/router/index.ts"), "utf8"));
}
