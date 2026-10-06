/**
 * Markdown матрицы покрытия (docs/lab/COVERAGE.md). Колонки-буквы: U unit, I integration, T кейс инструмента лаборатории,
 * S сценарий (scripted-мозг), R сценарий (реальный мозг), L только живьём. «ПК» — умеет ли FakeDesktop этот вид команд.
 */
import type { CoverageRow } from "../lib/contracts.js";
import type { CoverageReport } from "./matrix.js";

const COLS: Array<[string, string]> = [
  ["unit", "U"], ["integration", "I"], ["lab-tool", "T"], ["lab-scripted", "S"], ["lab-real", "R"], ["live-only", "L"],
];
const mark = (r: CoverageRow, key: string): string => (r.coveredBy.includes(key) ? "+" : "");
const name = (r: CoverageRow): string => r.id.slice(r.id.indexOf(":") + 1);
const esc = (s: string): string => s.replace(/\|/gu, "\|");
const head = (first: string, extra: string[]): string =>
  `| ${[first, ...COLS.map(([, l]) => l), ...extra, "Причина live-only"].join(" | ")} |\n|${"---|".repeat(1 + COLS.length + extra.length + 1)}`;

function table(rows: CoverageRow[], first: string, desktop: ReadonlySet<string> | null): string {
  const line = (r: CoverageRow): string => {
    const cells = [`\`${name(r)}\``, ...COLS.map(([k]) => mark(r, k)), ...(desktop ? [desktop.has(name(r)) ? "+" : ""] : []), r.liveOnly ? esc(r.liveOnly) : ""];
    return `| ${cells.join(" | ")} |`;
  };
  return `${head(first, desktop ? ["ПК"] : [])}\n${rows.map(line).join("\n")}`;
}

export function renderMarkdown(rep: CoverageReport): string {
  const { matrix: m } = rep;
  const of = (kind: CoverageRow["kind"]): CoverageRow[] => m.rows.filter((r) => r.kind === kind);
  const t = m.totals;
  const live = m.rows.filter((r) => r.liveOnly && r.coveredBy.every((c) => c === "live-only"));
  const out: string[] = [
    "# Матрица покрытия лаборатории",
    "",
    `Сгенерировано ${m.generatedAt.slice(0, 10)} командой \`node --import tsx infra/lab/coverage/cli.ts --write\` — руками не править.`,
    "Строки собираются из КОДА (схемы инструментов, ActionCommand, LocalIntent tier0); «чем покрыто» — grep тестов, кейсы инструментов лаборатории, `covers` сценариев, `liveOnly` из docs/lab/map.",
    "",
    "Колонки: **U** unit, **I** integration (эвристика по пути теста), **T** кейс инструмента лаборатории (прошёл), **S**/**R** сценарий scripted/real-мозгом, **L** только живьём, **ПК** — FakeDesktop умеет этот вид команд.",
    "",
    "## Итого",
    "",
    `Строк: **${t.rows ?? 0}** (инструментов ${t["kind:tool"] ?? 0}, видов команд ${t["kind:action"] ?? 0}, интентов ${t["kind:intent"] ?? 0}).`,
    "",
    "| Чем покрыто | Строк |",
    "|---|---|",
    ...[["unit", "unit"], ["integration", "integration"], ["lab-tool", "кейсы инструментов"], ["lab-scripted", "сценарии (scripted)"], ["lab-real", "сценарии (real)"], ["any-lab", "хоть чем-то из лаборатории"], ["live-only", "только живьём"], ["none", "НЕ покрыто"]].map(
      ([k, label]) => `| ${label} | ${t[`cover:${k}`] ?? 0} |`,
    ),
    "",
    `FakeDesktop умеет ${rep.fakeDesktop.supported.length} из ${rep.fakeDesktop.supported.length + rep.fakeDesktop.missing.length} видов команд${rep.fakeDesktop.missing.length ? `; не умеет: ${rep.fakeDesktop.missing.map((k) => `\`${k}\``).join(", ")}` : ""}.`,
    "",
    `## Не покрыто ничем (${m.uncovered.length})`,
    "",
    m.uncovered.length ? m.uncovered.map((id) => `- \`${id}\``).join("\n") : "Пусто.",
    "",
    `## Только живьём, без покрытия в тестах и лаборатории (${live.length})`,
    "",
    live.length ? live.map((r) => `- \`${r.id}\` — ${r.liveOnly}`).join("\n") : "Пусто.",
    "",
    "## Инструменты",
    "",
    table(of("tool"), "Инструмент", null),
    "",
    "## Виды команд клиенту (ActionCommand)",
    "",
    table(of("action"), "Вид", new Set(rep.fakeDesktop.supported)),
    "",
    "## Интенты tier0",
    "",
    table(of("intent"), "Интент", null),
  ];
  if (rep.warnings.length) out.push("", "## Замечания сборщика", "", ...rep.warnings.map((w) => `- ${w}`));
  return `${out.join("\n")}\n`;
}
