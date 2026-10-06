/**
 * Источники «не из тестов»: карта подсистем (docs/lab/map/*.json → liveOnly с причиной), сценарии лаборатории
 * (infra/lab/scenarios/*.ts, поле covers) и кейсы инструментов (tools/cases).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ACTUATOR_TOOL_BY_KIND, TOOLS_BY_NAME } from "../../../packages/tools/src/index.js";
import { ROOT } from "../lib/deps.js";
import type { Scenario } from "../lib/contracts.js";
import type { ToolCase } from "../tools/case-format.js";
import { skipReasonOf, type CaseResult } from "../tools/runner.js";
import { actionRow, type LabCaseCredit, type LiveOnlyEntry, type ScenarioCover, toolRow } from "./types.js";

interface MapCapability {
  id?: unknown;
  title?: unknown;
  liveOnly?: unknown;
}

/** id из карты → строки матрицы: имя инструмента, вид команды (в т.ч. `act.<kind>`), и связанная пара инструмент↔вид. */
export function rowsForMapId(rawId: string, tools: ReadonlySet<string>, actions: ReadonlySet<string>): string[] {
  const id = rawId.replace(/^(?:tool:|action:|act\.)/u, "");
  const rows: string[] = [];
  if (tools.has(id)) rows.push(toolRow(id));
  if (actions.has(id)) {
    rows.push(actionRow(id));
    const tool = (ACTUATOR_TOOL_BY_KIND as Record<string, string>)[id];
    if (tool && tools.has(tool)) rows.push(toolRow(tool));
  }
  return rows;
}

export function loadLiveOnly(tools: string[], actions: string[], dir = `${ROOT}/docs/lab/map`): LiveOnlyEntry[] {
  if (!existsSync(dir)) return [];
  const T = new Set(tools);
  const A = new Set(actions);
  const seen = new Map<string, LiveOnlyEntry>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { capabilities?: MapCapability[] };
    for (const cap of doc.capabilities ?? []) {
      if (cap.liveOnly !== true || typeof cap.id !== "string") continue;
      const reason = typeof cap.title === "string" && cap.title ? cap.title : "liveOnly в карте подсистемы (причина не записана)";
      for (const row of rowsForMapId(cap.id, T, A)) if (!seen.has(row)) seen.set(row, { row, reason, source: `docs/lab/map/${file}` });
    }
  }
  return [...seen.values()];
}

const isScenario = (v: unknown): v is Scenario => !!v && typeof v === "object" && typeof (v as Scenario).id === "string" && Array.isArray((v as Scenario).covers);

/** Сценарии: импорт модулей; сбой импорта → разбор текста (`covers: [...]`), чтобы сломанный файл не «терял» покрытие молча. */
export async function loadScenarios(dir = `${ROOT}/infra/lab/scenarios`): Promise<{ scenarios: ScenarioCover[]; warnings: string[] }> {
  const scenarios: ScenarioCover[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { scenarios, warnings };
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort()) {
    const file = `infra/lab/scenarios/${name}`;
    try {
      const mod = (await import(pathToFileURL(`${dir}/${name}`).href)) as Record<string, unknown>;
      for (const v of Object.values(mod).flatMap((x) => (Array.isArray(x) ? x : [x]))) {
        if (isScenario(v)) scenarios.push({ id: v.id, file, brain: v.brain, covers: [...v.covers], ...(v.liveOnly ? { liveOnly: v.liveOnly } : {}) });
      }
    } catch (e) {
      const text = readFileSync(`${dir}/${name}`, "utf8");
      const covers = [...text.matchAll(/covers:\s*\[([^\]]*)\]/gu)].flatMap((m) => [...m[1]!.matchAll(/["'`]([^"'`]+)["'`]/gu)].map((x) => x[1]!));
      warnings.push(`сценарии ${file} не импортировались (${e instanceof Error ? e.message : String(e)}); covers разобраны из текста`);
      if (covers.length) scenarios.push({ id: `${name}#text`, file, brain: "either", covers });
    }
  }
  return { scenarios, warnings };
}

/**
 * Кейсы → строки матрицы. Засчитывается только кейс, который реально доказывает: не пропущенный вручную/по неподдержанному
 * виду команд и — если переданы результаты прогона — прошедший. Кейс `fs_write` доказывает `tool:fs_write` и виды из actionKinds.
 */
export function creditCases(cases: readonly ToolCase[], supported: ReadonlySet<string>, results?: readonly CaseResult[]): { credits: LabCaseCredit[]; warnings: string[] } {
  const passed = results ? new Set(results.filter((r) => r.status === "pass").map((r) => r.id)) : null;
  const credits: LabCaseCredit[] = [];
  const warnings: string[] = [];
  for (const c of cases) {
    const id = `${c.tool}: ${c.name}`;
    if (skipReasonOf(c, supported) !== null) continue;
    if (passed && !passed.has(id)) {
      warnings.push(`кейс «${id}» не прошёл — покрытие не засчитано`);
      continue;
    }
    if (!TOOLS_BY_NAME[c.coversTool]) {
      warnings.push(`кейс «${id}»: coversTool=${c.coversTool} — нет такого инструмента в схемах`);
      continue;
    }
    const kinds = new Set(c.expect.actionKinds ?? []);
    credits.push({ id, rows: [toolRow(c.coversTool), ...[...kinds].map(actionRow)] });
  }
  return { credits, warnings };
}
