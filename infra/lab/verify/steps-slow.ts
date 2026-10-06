/** Тяжёлые шаги full/verify: якоря мутаций, mutate-loop, стенд браузера, сравнение с прошлым прогоном. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorsOutcome, mutationReportOutcome, validateAnchors } from "./anchors.js";
import { benchGate, runBench } from "./bench.js";
import { compareRuns, latestReport } from "./compare.js";
import { VERIFY_UP } from "./steps-core.js";
import type { Step } from "./types.js";

const MIN = 60_000;
const MUTATE = "apps/server/scripts/mutate-loop.cjs";
const report = (workDir: string): string => join(workDir, "mutation-table.json");

export const SLOW_STEPS: Step[] = [
  {
    id: "mutate:anchors", title: "mutate-loop: каждый якорь мутации найден ровно один раз", profiles: VERIFY_UP, timeoutMs: MIN,
    inproc: async (c) => anchorsOutcome(validateAnchors(join(c.root, MUTATE), join(c.root, "apps/server"))),
  },
  {
    id: "mutate:loop", title: "mutate-loop all (мутации петли; провал = якорь потерян)", profiles: ["full"], timeoutMs: 60 * MIN,
    gate: (_c, done) => (done.find((d) => d.id === "mutate:anchors")?.status === "fail" ? { status: "skip", reason: "якоря дрейфуют (см. mutate:anchors) — 15-40 минут прогона были бы впустую" } : null),
    exec: (c) => ({ cmd: process.execPath, args: ["scripts/mutate-loop.cjs", "all", report(c.workDir)], cwd: join(c.root, "apps/server") }),
    parse: (res, c) => {
      if (res.timedOut) return { status: "fail", reason: "таймаут mutate-loop (файл петли мог остаться мутированным — проверь git diff apps/server/src/brain/agent)" };
      try { return mutationReportOutcome(readFileSync(report(c.workDir), "utf8")); } catch { return { status: "fail", reason: `mutate-loop не записал отчёт (код ${res.code})` }; }
    },
  },
  {
    id: "bench", title: "стенд браузера (Xvfb + Chromium + сценарии)", profiles: ["full"], timeoutMs: 25 * MIN,
    gate: benchGate,
    inproc: runBench,
  },
  {
    id: "compare:previous", title: "сравнение с прошлым прогоном full (новые skip, рост времени >20%)", profiles: ["full"], timeoutMs: MIN,
    inproc: async (c, done) => compareRuns(latestReport(c.runsDir, c.profile), done),
  },
];
