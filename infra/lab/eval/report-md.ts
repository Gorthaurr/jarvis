/** EvalReport → Markdown: сводка pass-rate, провалы С ПРИЧИНОЙ, контроль без мозга, пропуски. Чистая функция. */
import { controlVerdicts } from "./stats.js";
import type { EvalReportX, EvalRun, EvalScenario } from "./types.js";

const cell = (s: string): string => s.replace(/\|/gu, "\|").replace(/\s*\n\s*/gu, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const sec = (ms: number): string => `${(ms / 1000).toFixed(1)} с`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

const MODE = {
  real: "**real** — настоящий мозг по подписке владельца",
  off: "**off** — без модели: закрывается только tier0 ($0), остальное — отрицательный контроль (в контракте brain=\"scripted\")",
} as const;

function summaryTable(rep: EvalReportX, titles: Map<string, string>): string[] {
  const rows = Object.entries(rep.bySrenario).map(([id, s]) => {
    const err = s.error ? ` (ошибок прогона: ${s.error})` : "";
    return `| \`${id}\` | ${cell(titles.get(id) ?? "")} | ${s.pass}/${s.total}${err} | ${pct(s.rate)} | ${sec(s.medianMs)} | ${cell(s.tools.join(", ") || "—")} |`;
  });
  return ["## Сводка", "", "| сценарий | цель | pass/всего | pass-rate | медиана | инструменты |", "|---|---|---|---|---|---|", ...rows, ""];
}

function problems(runs: EvalRun[], byId: Map<string, EvalScenario>): string[] {
  const bad = runs.filter((r) => r.outcome !== "pass" && !r.control);
  if (bad.length === 0) return [];
  const out = ["## Провалы и ошибки прогонов", ""];
  for (const r of bad) {
    const kind = r.outcome === "error" ? "ОШИБКА ПРОГОНА (не провал проверки)" : r.budget ? `провал: бюджет ${r.budget}` : "провал проверки";
    out.push(`### \`${r.scenarioId}\` #${r.n} — ${kind}`, "", `- цель: «${byId.get(r.scenarioId)?.goal ?? "?"}»`, `- причина: ${clip(r.why, 600)}`, `- ответ Джарвиса: «${clip(r.answer, 240)}»`, `- инструменты: ${r.tools.join(", ") || "—"}; действий ${r.actions}, раундов модели ${r.rounds}, ${sec(r.ms)}${r.overflow ? `, ответов §14 «по умолчанию нет» (массив кончился): ${r.overflow}` : ""}`, "");
  }
  return out;
}

function controlSection(rep: EvalReportX): string[] {
  const v = controlVerdicts(rep.runs);
  if (v.length === 0) return [];
  const bad = v.filter((x) => !x.red);
  return [
    "## Отрицательный контроль (без мозга)", "",
    "Сценарии real-only гоняются без модели: цель достигаться не должна. Зелёная проверка без мозга — декоративна.", "",
    ...v.map((x) => `- \`${x.id}\`: ${x.red ? "красная без мозга — проверка ловит провал" : "**ЗЕЛЁНАЯ без мозга — проверка ДЕКОРАТИВНА**"}`),
    "", bad.length ? `**Итог: декоративных проверок ${bad.length}.**` : `Итог: все ${v.length} проверок краснеют без мозга.`, "",
  ];
}

export function renderMarkdown(rep: EvalReportX, scenarios: readonly EvalScenario[] = []): string {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const titles = new Map(scenarios.map((s) => [s.id, s.title]));
  const c = { pass: 0, fail: 0, error: 0 };
  for (const r of rep.runs) c[r.outcome] += 1;
  const took = Date.parse(rep.finishedAt) - Date.parse(rep.startedAt);
  return [
    `# Eval ${rep.label}`, "",
    `- запуск: ${rep.startedAt}, длительность ${sec(took)}`, `- мозг: ${MODE[rep.mode]}${rep.control ? "; включён --control" : ""}`,
    `- сценариев запущено ${Object.keys(rep.bySrenario).length}, пропущено ${rep.skipped.length}; прогонов ${rep.runs.length}: **pass ${c.pass}**, fail ${c.fail}, error ${c.error}`, "",
    ...(rep.runs.length ? summaryTable(rep, titles) : ["Ни один сценарий не запускался.", ""]),
    ...problems(rep.runs, byId), ...controlSection(rep),
    ...(rep.skipped.length ? ["## Пропущено (не гонялось)", "", "| сценарий | причина |", "|---|---|", ...rep.skipped.map((s) => `| \`${s.id}\` | ${cell(s.reason)} |`), ""] : []),
    ...(rep.notes.length ? ["## Замечания раннера", "", ...rep.notes.map((n) => `- ${n}`), ""] : []),
    "Проверки идут по ИТОГОВОМУ состоянию FakeDesktop и журналу команд/вопросов §14, а не по словам модели; pass-rate = pass / все прогоны (ошибка прогона в знаменателе, но не считается провалом мозга).", "",
  ].join("\n");
}
