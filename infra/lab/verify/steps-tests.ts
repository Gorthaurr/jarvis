/**
 * vitest-шаги. quick: по изменённому (--changed base) для server/client; verify/full: набор целиком.
 * Каждый шаг пишет JSON-отчёт в workDir и разбирается по нему (stdout усечён и не источник истины).
 */
import { join } from "node:path";
import { PACKAGES, ALL, VERIFY_UP } from "./steps-core.js";
import { vitestOutcome, vitestSpec } from "./tools.js";
import type { Ctx, ProfileName, Step } from "./types.js";

const MIN = 60_000;
const json = (c: Ctx, id: string): string => join(c.workDir, `vitest-${id.replace(/[^\w-]/gu, "_")}.json`);

interface VitestStepDef {
  id: string;
  title: string;
  profiles: ProfileName[];
  cwd: string;
  args: (c: Ctx) => string[];
  timeoutMin: number;
  allowZero?: boolean;
  zeroNote?: string;
  needsBase?: boolean;
}

export function vitestStep(d: VitestStepDef): Step {
  return {
    id: d.id, title: d.title, profiles: d.profiles, timeoutMs: d.timeoutMin * MIN,
    gate: d.needsBase ? (c) => (c.base ? null : { status: "fail", reason: "нет origin/main и main — --changed не с чем сравнивать" }) : undefined,
    exec: (c) => vitestSpec(c, { cwd: join(c.root, d.cwd), args: d.args(c), jsonFile: json(c, d.id) }),
    parse: (res, c) => vitestOutcome(res, c, json(c, d.id), { allowZero: d.allowZero, zeroNote: d.zeroNote }),
  };
}

const changed = (c: Ctx): string[] => ["--changed", c.base ?? "", "--passWithNoTests"];
const NOTHING = "нет изменённых файлов с тестами относительно base — quick ничего не проверил в этом наборе";

const changedSteps = ["server", "client"].map((id) => {
  const p = PACKAGES.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return vitestStep({ id: `vitest:${id}:changed`, title: `vitest --changed ${p.dir}`, profiles: ["quick"], cwd: p.dir, args: changed, timeoutMin: 15, allowZero: true, zeroNote: NOTHING, needsBase: true });
});

const fullSteps = PACKAGES.map((p) => {
  const heavy = p.id === "server" || p.id === "client";
  const quick = !heavy; // мелкие пакеты гоняем целиком уже в quick (секунды)
  return vitestStep({
    id: `vitest:${p.id}`, title: `vitest run ${p.dir}${heavy ? " (полный набор)" : ""}`,
    profiles: quick ? ALL : VERIFY_UP, cwd: p.dir, args: () => ["--passWithNoTests"],
    timeoutMin: p.id === "server" ? 30 : 15, allowZero: p.id === "userbots", zeroNote: "userbots: в пакете нет тестов вообще — код senders не проверен автотестами",
  });
});

export const TEST_STEPS: Step[] = [
  ...changedSteps,
  ...fullSteps,
  // Тест гейта размеров — vitest-файл (node --test его не запустит: import "vitest"); --changed его не подберёт.
  vitestStep({ id: "vitest:gate-test", title: "vitest module-size-gate.test.mjs", profiles: ["quick"], cwd: "apps/server", args: () => ["scripts/module-size-gate.test.mjs"], timeoutMin: 3 }),
  vitestStep({ id: "vitest:lab", title: "vitest тесты лаборатории (infra/lab)", profiles: VERIFY_UP, cwd: ".", args: () => ["--root", "infra/lab"], timeoutMin: 20 }),
];
