/** Запись отчёта: docs/lab/runs/eval-<метка>.md и .json (по образцу verify-отчётов). */
import { mkdirSync, writeFileSync } from "node:fs";
import { repoRoot } from "../lib/deps.js";
import { renderMarkdown } from "./report-md.js";
import type { EvalReportX, EvalScenario } from "./types.js";

export const safeLabel = (label: string): string => label.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "") || "run";

export function writeReport(rep: EvalReportX, scenarios: readonly EvalScenario[] = [], dir: string = repoRoot("docs/lab/runs")): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const base = `${dir}/eval-${safeLabel(rep.label)}`;
  writeFileSync(`${base}.md`, renderMarkdown(rep, scenarios), "utf8");
  writeFileSync(`${base}.json`, `${JSON.stringify(rep, null, 2)}\n`, "utf8");
  return { md: `${base}.md`, json: `${base}.json` };
}
