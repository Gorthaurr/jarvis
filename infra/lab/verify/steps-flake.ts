/** Шаги флейк-скана: изменённые тест-файлы ×5 (verify) и полные прогоны ×3 (full). Логика — infra/lab/flake/. */
import { describeFlakes, scanFlakes, type FlakeReport } from "../flake/scan.js";
import { vitestRunOnce, type FlakeTarget } from "../flake/vitest-run.js";
import { changedTestFiles, targetsForFiles } from "./changed.js";
import { PACKAGES, VERIFY_UP } from "./steps-core.js";
import type { Ctx, Step, StepOutcome } from "./types.js";

export const K_CHANGED = 5;
export const K_FULL = 3;
const MIN = 60_000;

export function flakeOutcome(reports: FlakeReport[], unverified: string[] = []): StepOutcome {
  const bad = reports.flatMap((r) => [
    ...r.unstable.map((u) => `нестабилен ${u.failed} из ${u.of}: ${u.test}`),
    ...r.alwaysFailed.map((u) => `падает во всех ${u.of} прогонах: ${u.test}`),
    ...(r.emptyRuns ? [`${r.id}: ${r.emptyRuns} из ${r.runs} прогонов не дали отчёта vitest`] : []),
  ]);
  const notes = reports.map(describeFlakes);
  return bad.length ? { status: "fail", reason: bad.slice(0, 8).join("; "), notes, unverified } : { status: "pass", notes, unverified };
}

async function scanAll(ctx: Ctx, targets: FlakeTarget[], k: number, perRunMs: number): Promise<FlakeReport[]> {
  const out: FlakeReport[] = [];
  for (const t of targets) out.push(await scanFlakes(t.id, k, vitestRunOnce(ctx, t, perRunMs)));
  return out;
}

export const FLAKE_STEPS: Step[] = [
  {
    id: "flake:changed", title: `флейк-скан изменённых тест-файлов ×${K_CHANGED}`, profiles: VERIFY_UP, timeoutMs: 40 * MIN,
    gate: (c) => (c.base ? null : { status: "fail", reason: "нет origin/main и main — не знаем, какие тесты изменены" }),
    inproc: async (c) => {
      const files = changedTestFiles(c.root, c.base ?? "");
      if (!files.length) return { status: "pass", notes: ["изменённых тест-файлов нет"], unverified: ["флейк-скан: нечего сканировать (тесты не менялись)"] };
      const { targets, unscanned } = targetsForFiles(c.root, files);
      const un = unscanned.length ? [`флейк-скан не покрывает node:test/прочие файлы: ${unscanned.slice(0, 5).join(", ")}`] : [];
      return flakeOutcome(await scanAll(c, targets, K_CHANGED, 10 * MIN), un);
    },
  },
  {
    id: "flake:full", title: `флейк-скан: полные прогоны vitest ×${K_FULL}`, profiles: ["full"], timeoutMs: 120 * MIN,
    inproc: async (c) => {
      const targets: FlakeTarget[] = PACKAGES.filter((p) => p.id !== "userbots").map((p) => ({ id: p.dir, cwd: `${c.root}/${p.dir}`, args: [] }));
      targets.push({ id: "infra/lab", cwd: c.root, args: ["--root", "infra/lab"] });
      return flakeOutcome(await scanAll(c, targets, K_FULL, 30 * MIN));
    },
  },
];
