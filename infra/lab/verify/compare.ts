/**
 * Сравнение с прошлым прогоном того же профиля (verify:full). Ловит то, что тихо портится при зелёном статусе:
 * НОВЫЕ пропуски тестов и рост времени шага > 20% (шаги короче 10 с — шум, не сравниваем).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProfileName, RunReport, StepOutcome, StepResult } from "./types.js";

export const GROWTH_LIMIT = 1.2;
export const MIN_COMPARABLE_MS = 10_000;

/** Самый свежий отчёт профиля из каталога (имя файла — дата-время, сортировка по имени = по времени). */
export function latestReport(runsDir: string, profile: ProfileName): RunReport | null {
  let names: string[] = [];
  try { names = readdirSync(runsDir).filter((n) => n.endsWith(".json")).sort().reverse(); } catch { return null; }
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(runsDir, n), "utf8")) as RunReport;
      if (r.version === 1 && r.profile === profile) return r;
    } catch { /* битый файл пропускаем */ }
  }
  return null;
}

const skipKeys = (steps: StepResult[]): Set<string> =>
  new Set(steps.flatMap((s) => (s.skipped ?? []).map((t) => `${s.id} | ${t.file} > ${t.name}`)));

export function compareRuns(prev: RunReport | null, cur: StepResult[]): StepOutcome {
  if (!prev) return { status: "pass", notes: ["прошлого прогона этого профиля нет — сравнивать не с чем"], unverified: ["сравнение с прошлым прогоном не выполнено (первый прогон)"] };
  const bad: string[] = [];
  const before = skipKeys(prev.steps);
  const fresh = [...skipKeys(cur)].filter((k) => !before.has(k));
  if (fresh.length) bad.push(`новых пропущенных тестов: ${fresh.length} (${fresh.slice(0, 3).join("; ")})`);
  const byId = new Map(prev.steps.map((s) => [s.id, s]));
  const notes: string[] = [];
  for (const s of cur) {
    const p = byId.get(s.id);
    if (!p || p.status !== "pass" || s.status !== "pass") continue;
    if (p.ms >= MIN_COMPARABLE_MS && s.ms > p.ms * GROWTH_LIMIT) bad.push(`${s.id}: ${Math.round(p.ms / 1000)} с → ${Math.round(s.ms / 1000)} с (+${Math.round((s.ms / p.ms - 1) * 100)}%)`);
    if (p.tests && s.tests && s.tests.total < p.tests.total) notes.push(`${s.id}: тестов стало меньше ${p.tests.total} → ${s.tests.total}`);
  }
  return bad.length ? { status: "fail", reason: bad.join("; "), notes } : { status: "pass", notes: [`сравнено с прогоном ${prev.startedAt}`, ...notes] };
}
