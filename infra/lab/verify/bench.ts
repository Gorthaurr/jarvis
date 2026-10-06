/**
 * Стенд браузера (infra/bench): up → сценарии → down (down ВСЕГДА). Стенд — Linux/Xvfb (облако); на Windows шаг
 * честно пропускается с причиной, а не изображает зелёный.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runExec } from "./exec.js";
import { parseNodeTest } from "./parse.js";
import { testFilesOf } from "./steps-core.js";
import type { Ctx, StepOutcome } from "./types.js";

export function benchGate(c: Ctx): { status: "skip"; reason: string } | null {
  if (c.platform !== "linux") return { status: "skip", reason: `стенд браузера — только Linux/Xvfb (облако), здесь ${c.platform}; браузерные руки в этом прогоне не проверены` };
  const has = spawnSync("which", ["Xvfb"], { stdio: "ignore" }).status === 0;
  return has ? null : { status: "skip", reason: "нет Xvfb в PATH (node infra/bench/bench.mjs setup ставит зависимости)" };
}

export async function runBench(c: Ctx): Promise<StepOutcome> {
  const node = process.execPath;
  const bench = join(c.root, "infra/bench/bench.mjs");
  const step = (args: string[], timeoutMs: number) => runExec({ cmd: node, args, cwd: c.root, timeoutMs });
  try {
    const up = await step([bench, "up"], 5 * 60_000);
    if (up.code !== 0) return { status: "fail", reason: `bench up: код ${up.code}${up.timedOut ? " (таймаут)" : ""}`, notes: [up.out.slice(-800)] };
    const files = testFilesOf(c.root, "infra/bench/scenarios", ".test.mjs");
    const run = await step(["--test", "--test-concurrency=1", "--test-reporter=tap", ...files], 15 * 60_000);
    const t = parseNodeTest(run.out);
    if (!t) return { status: "fail", reason: "нет итога node --test сценариев стенда", notes: [run.out.slice(-800)] };
    const ok = run.code === 0 && t.failed === 0 && t.total > 0;
    return { status: ok ? "pass" : "fail", reason: ok ? undefined : `сценариев упало: ${t.failed} из ${t.total}`, tests: t };
  } finally {
    await step([bench, "down"], 2 * 60_000);
  }
}
