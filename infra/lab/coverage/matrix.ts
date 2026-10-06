/**
 * Матрица покрытия: ЧИСТОЕ ядро `buildMatrix(sources)` (тестируется синтетикой) + сборщик `buildCoverage()` из кода репозитория.
 * Строка = инструмент | вид ActionCommand | интент tier0; «чем покрыто» — unit/integration (grep тестов), lab-tool (кейсы
 * инструментов), lab-scripted/lab-real (сценарии по полю covers), live-only (карта подсистем, причина). Пусто → "none".
 */
import type { CoverageMatrix, CoverageRow } from "../lib/contracts.js";
import { supportedKinds } from "../desktop/index.js";
import { loadCases } from "../tools/load-cases.js";
import { runCases } from "../tools/runner.js";
import { collectActions, collectIntents, collectTools } from "./sources-code.js";
import { creditCases, loadLiveOnly, loadScenarios } from "./sources-map.js";
import { scanTests } from "./sources-tests.js";
import { actionRow, type CoverageSources, intentRow, toolRow } from "./types.js";

export interface CoverageReport {
  matrix: CoverageMatrix;
  /** Виды команд: что FakeDesktop умеет и чего нет. */
  fakeDesktop: { supported: string[]; missing: string[] };
  warnings: string[];
}

/** cover из сценария → id строк: `tool:x`/`action:y`/`intent:z` точно; голое имя — все строки с таким именем. */
export function resolveCover(cover: string, byName: ReadonlyMap<string, string[]>, ids: ReadonlySet<string>): string[] {
  if (/^(?:tool|action|intent|flow):/u.test(cover)) return ids.has(cover) ? [cover] : [];
  return byName.get(cover) ?? [];
}

export function buildMatrix(src: CoverageSources, now: Date = new Date()): CoverageReport {
  const rows: CoverageRow[] = [
    ...src.tools.map((n): CoverageRow => ({ id: toolRow(n), kind: "tool", coveredBy: [] })),
    ...src.actions.map((k): CoverageRow => ({ id: actionRow(k), kind: "action", coveredBy: [] })),
    ...src.intents.map((k): CoverageRow => ({ id: intentRow(k), kind: "intent", coveredBy: [] })),
  ];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = new Set(byId.keys());
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    const name = r.id.slice(r.id.indexOf(":") + 1);
    byName.set(name, [...(byName.get(name) ?? []), r.id]);
  }
  const warnings = [...src.warnings];
  const add = (id: string, by: string): void => {
    const r = byId.get(id);
    if (r && !r.coveredBy.includes(by)) r.coveredBy.push(by);
  };

  for (const t of src.tests) for (const id of t.rows) add(id, t.layer);
  for (const c of src.labCases) for (const id of c.rows) if (byId.has(id)) add(id, "lab-tool"); else warnings.push(`кейс «${c.id}» ссылается на несуществующую строку ${id}`);
  for (const s of src.scenarios) {
    for (const cover of s.covers) {
      const hit = resolveCover(cover, byName, ids);
      if (hit.length === 0) warnings.push(`сценарий ${s.id}: covers «${cover}» не соответствует ни одной строке матрицы`);
      for (const id of hit) {
        if (s.liveOnly) {
          // Сценарий «только живьём» описывает ЧТО проверять, но без владельца ничего не доказывает.
          const r = byId.get(id)!;
          r.liveOnly ??= s.liveOnly;
          add(id, "live-only");
        } else add(id, s.brain === "real" ? "lab-real" : "lab-scripted");
      }
    }
  }
  for (const l of src.liveOnly) {
    const r = byId.get(l.row);
    if (!r) continue;
    r.liveOnly = l.reason;
    add(l.row, "live-only");
  }
  for (const r of rows) {
    r.coveredBy.sort();
    if (r.coveredBy.length === 0) r.coveredBy.push("none");
  }

  const totals: Record<string, number> = { rows: rows.length };
  for (const r of rows) {
    totals[`kind:${r.kind}`] = (totals[`kind:${r.kind}`] ?? 0) + 1;
    for (const c of r.coveredBy) totals[`cover:${c}`] = (totals[`cover:${c}`] ?? 0) + 1;
    if (r.coveredBy.some((c) => c.startsWith("lab-"))) totals["cover:any-lab"] = (totals["cover:any-lab"] ?? 0) + 1;
  }
  const have = new Set(src.fakeDesktopKinds);
  return {
    matrix: { generatedAt: now.toISOString(), rows, totals, uncovered: rows.filter((r) => r.coveredBy.includes("none")).map((r) => r.id) },
    fakeDesktop: { supported: src.actions.filter((a) => have.has(a)), missing: src.actions.filter((a) => !have.has(a)) },
    warnings,
  };
}

export interface CoverageOptions {
  /** Реально прогнать кейсы инструментов и засчитать только прошедшие (по умолчанию да; false — по статическому виду). */
  runCases?: boolean;
}

/** Собрать матрицу из кода репозитория. */
export async function buildCoverage(opts: CoverageOptions = {}): Promise<CoverageReport> {
  const tools = collectTools();
  const actions = collectActions();
  const intents = collectIntents();
  const fakeDesktopKinds = supportedKinds();
  const scan = scanTests({ tools, actions, intents });
  const { scenarios, warnings: scWarn } = await loadScenarios();
  const loaded = await loadCases();
  const caseWarn = loaded.files.filter((f) => f.error).map((f) => `кейсы ${f.file} не загружены: ${f.error}`);
  const supported = new Set(fakeDesktopKinds);
  const results = opts.runCases === false ? undefined : await runCases(loaded.cases, { supported });
  const { credits, warnings: creditWarn } = creditCases(loaded.cases, supported, results);
  return buildMatrix({
    tools,
    actions,
    intents,
    tests: scan.tests,
    liveOnly: loadLiveOnly(tools, actions),
    scenarios,
    labCases: credits,
    fakeDesktopKinds,
    warnings: [...scan.warnings, ...scWarn, ...caseWarn, ...creditWarn],
  });
}
