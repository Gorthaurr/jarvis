/**
 * Раннер eval: сценарии × N прогонов на ОДНОМ лаб-сервере набора (каждый прогон — свой клиент и своя партиция памяти,
 * свежий FakeDesktop). Сервер гасится всегда. Мозг: `real` — по подписке владельца (тратит лимит), `off` — без модели:
 * закрывает только tier0 ($0), остальное — отрицательный контроль (`control`).
 */
import { statsOf } from "./stats.js";
import { runOne } from "./run-one.js";
import { selectScenarios } from "./select.js";
import type { EvalDeps, EvalOptions, EvalReportX, EvalRun, EvalScenario } from "./types.js";

/** Самоосмотр сервера («посмотрел на свои логи…») приходит отдельным chat и подменил бы `answer` первого хода каждой партиции. */
const QUIET_SERVER_ENV = { JARVIS_SELF_REVIEW: "0" };

async function resolveDeps(over: Partial<EvalDeps> = {}): Promise<EvalDeps> {
  if (over.startServer && over.connectClient && over.createDesktop) return over as EvalDeps;
  const { realDeps } = await import("./env.js");
  return { ...(await realDeps()), ...over };
}

export async function runEval(all: readonly EvalScenario[], opts: EvalOptions): Promise<EvalReportX> {
  const startedAt = new Date().toISOString();
  const n = Math.max(1, Math.floor(opts.n ?? 1));
  const sel = selectScenarios(all, opts);
  const runs: EvalRun[] = [];
  const notes: string[] = [];
  if (sel.run.length > 0) {
    const deps = await resolveDeps(opts.deps);
    const server = await deps.startServer({ brain: opts.brain, env: { ...QUIET_SERVER_ENV, ...opts.serverEnv } });
    try {
      for (const s of sel.run) {
        for (let i = 1; i <= n; i += 1) {
          const run = await runOne(s, i, { server, deps, mode: opts.brain, ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}) });
          if (opts.brain === "off" && s.brain === "real") run.control = true;
          runs.push(run);
          opts.onRun?.(run);
        }
      }
    } finally {
      await server.stop().catch((e: unknown) => notes.push(`сервер лаборатории не остановился: ${e instanceof Error ? e.message : String(e)} — проверь \`lab.ts status\``));
    }
  }
  return {
    startedAt, finishedAt: new Date().toISOString(), brain: opts.brain === "real" ? "real" : "scripted", mode: opts.brain, control: opts.control === true,
    label: opts.label ?? startedAt.replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "").replace("T", "-"), runs, bySrenario: statsOf(runs), skipped: sel.skipped, notes,
  };
}
