/**
 * Флейк-скан: один и тот же набор тестов K раз подряд, отчёт «стабильно / нестабильно (n из K)».
 * classify — чистая функция над таблицами исходов; scanFlakes — цикл поверх любого runOnce (настоящий vitest —
 * flake/vitest-run.ts). Пропущенный (skipped) тест нестабильным не считается: он ничего не показал.
 */
import { knownFlakeOf, KNOWN_FLAKES, type KnownFlake } from "./known.js";

export type Outcome = "passed" | "failed" | "skipped";
/** Исходы одного прогона: ключ «файл > имя теста» → исход. */
export type RunOutcomes = Map<string, Outcome>;

export interface FlakeRow { test: string; failed: number; of: number; known?: string }

export interface FlakeReport {
  id: string;
  runs: number;
  /** Тестов, увиденных хотя бы в одном прогоне. */
  seen: number;
  stable: number;
  /** Упали во ВСЕХ прогонах — это не флейк, а сломанный тест. */
  alwaysFailed: FlakeRow[];
  /** Нестабильные, которых нет в списке известных → валят прогон. */
  unstable: FlakeRow[];
  /** Нестабильные из списка известных. */
  knownUnstable: FlakeRow[];
  /** Прогонов, не давших исходов вообще (vitest не запустился/упал до отчёта). */
  emptyRuns: number;
}

export function classify(id: string, perRun: RunOutcomes[], known: KnownFlake[] = KNOWN_FLAKES): FlakeReport {
  const keys = new Set<string>();
  for (const r of perRun) for (const k of r.keys()) keys.add(k);
  const rep: FlakeReport = { id, runs: perRun.length, seen: keys.size, stable: 0, alwaysFailed: [], unstable: [], knownUnstable: [], emptyRuns: perRun.filter((r) => r.size === 0).length };
  for (const key of [...keys].sort()) {
    const outcomes = perRun.map((r) => r.get(key)).filter((o): o is Outcome => o !== undefined && o !== "skipped");
    const failed = outcomes.filter((o) => o === "failed").length;
    const row: FlakeRow = { test: key, failed, of: outcomes.length };
    if (failed === 0 || outcomes.length === 0) rep.stable++;
    else if (failed === outcomes.length) rep.alwaysFailed.push(row);
    else {
      const k = knownFlakeOf(key, known);
      if (k) rep.knownUnstable.push({ ...row, known: k.reason });
      else rep.unstable.push(row);
    }
  }
  return rep;
}

export async function scanFlakes(id: string, k: number, runOnce: (i: number) => Promise<RunOutcomes>, known?: KnownFlake[]): Promise<FlakeReport> {
  const perRun: RunOutcomes[] = [];
  for (let i = 0; i < k; i++) perRun.push(await runOnce(i));
  return classify(id, perRun, known);
}

/** Одна строка отчёта для людей. */
export const describeFlakes = (r: FlakeReport): string => {
  const parts = [`${r.id}: ${r.stable}/${r.seen} стабильно за ${r.runs} прогонов`];
  for (const u of r.unstable) parts.push(`НЕСТАБИЛЬНО ${u.failed} из ${u.of}: ${u.test}`);
  for (const u of r.knownUnstable) parts.push(`известный флейк ${u.failed} из ${u.of}: ${u.test} (${u.known})`);
  for (const u of r.alwaysFailed) parts.push(`падает всегда: ${u.test}`);
  if (r.emptyRuns) parts.push(`прогонов без исходов: ${r.emptyRuns}`);
  return parts.join("; ");
};
