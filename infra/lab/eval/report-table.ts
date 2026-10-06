/** Текстовая таблица eval для терминала (человеку и агенту); подробности — в Markdown-отчёте. */
import type { EvalReportX } from "./types.js";

const MARK = { pass: "PASS", fail: "FAIL", error: "ERR " } as const;

export function formatTable(rep: EvalReportX): string {
  const w = Math.max(10, ...rep.runs.map((r) => r.scenarioId.length));
  const lines = rep.runs.map((r) => `${MARK[r.outcome]}  ${r.scenarioId.padEnd(w)}  #${r.n}  ${String(r.ms).padStart(6)}ms  ${r.control ? "[контроль] " : ""}${r.outcome === "pass" ? "" : r.why.slice(0, 160)}`);
  const c = { pass: 0, fail: 0, error: 0 };
  for (const r of rep.runs) c[r.outcome] += 1;
  const skipped = rep.skipped.map((s) => `skip  ${s.id.padEnd(w)}  ${s.reason.slice(0, 120)}`);
  return [...lines, ...skipped, "", `режим ${rep.mode} | прогонов ${rep.runs.length}: pass ${c.pass}, fail ${c.fail}, error ${c.error} | пропущено ${rep.skipped.length}`].join("\n");
}
