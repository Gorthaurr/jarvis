/**
 * Один прогон сценария: свежий FakeDesktop + свой лаб-клиент (новая партиция памяти) на общем сервере набора, разговор по
 * шагам, проверка по ИТОГОВОМУ состоянию. Исходы: pass / fail (цель не достигнута или бюджет) / error (сломался сам прогон:
 * не подключились, сервер упал, упал check) — в статистику мозга error не входит.
 */
import { randomUUID } from "node:crypto";
import type { CheckResult, LabServer, TurnResult } from "../lib/contracts.js";
import { serverActivity } from "./metrics.js";
import { actionCount, applyServices, budgetHit, converse, explain, outcomeOf, sleep } from "./run-parts.js";
import type { EvalClient, EvalContext, EvalDeps, EvalRun, EvalScenario } from "./types.js";

export interface RunEnv {
  server: LabServer;
  deps: EvalDeps;
  mode: "off" | "real";
  settleMs?: number;
}

/** Ход под off, дошедший до модели, — стаб «связь прервалась»: без этой пометки регрессия tier0 выглядела бы как обычный провал. */
const STUB_NOTE = " [ход дошёл до модели, а при мозге off она отвечает стабом «связь прервалась»]";

const errorRun = (s: EvalScenario, n: number, mode: RunEnv["mode"], t0: number, turns: readonly TurnResult[], e: unknown): EvalRun => {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    scenarioId: s.id, n, brain: mode === "real" ? "real" : "scripted", outcome: "error", pass: false, why: `ошибка прогона (не провал проверки): ${msg.split("\n")[0]}`,
    ms: Date.now() - t0, actions: actionCount(turns), tools: [], answer: turns[turns.length - 1]?.answer ?? "", rounds: 0, error: msg,
  };
};

export async function runOne(s: EvalScenario, n: number, env: RunEnv): Promise<EvalRun> {
  const t0 = Date.now();
  const userId = randomUUID();
  const restore = applyServices(s.services);
  const turns: TurnResult[] = [];
  let client: EvalClient | undefined;
  try {
    const desktop = env.deps.createDesktop(s.seed);
    const before = desktop.snapshot();
    client = await env.deps.connectClient({
      server: env.server, desktop, token: userId,
      ...(s.confirm !== undefined ? { confirm: s.confirm } : {}), ...(s.faults ? { faults: s.faults } : {}), ...(env.settleMs !== undefined ? { settleMs: env.settleMs } : {}),
    });
    const marks = await converse(client, desktop, s, turns);
    if (s.settleMs) await sleep(s.settleMs);
    const ctx: EvalContext = { desktop: desktop.snapshot(), before, turns, turn: turns[turns.length - 1]!, marks, server: env.server, userId };
    const budget = budgetHit(s, turns);
    if (budget === "time" && !(await env.server.health().catch(() => ({ ok: false }))).ok) throw new Error("сервер не отвечает после таймаута хода (упал или завис)");
    let verdict: CheckResult;
    try {
      verdict = await s.check(ctx);
    } catch (e) {
      throw new Error(`check() сценария «${s.id}» упал: ${e instanceof Error ? e.message : String(e)}`);
    }
    const act = serverActivity(env.server, t0, Date.now(), turns);
    const pass = verdict.pass && !budget;
    const stub = env.mode === "off" && !pass && act.rounds > 0 ? STUB_NOTE : "";
    const overflow = client.decisions?.().filter((d) => d.overflow).length ?? 0;
    return {
      scenarioId: s.id, n, brain: env.mode === "real" ? "real" : "scripted", outcome: outcomeOf(pass), pass, why: explain(s, budget, turns, verdict.why) + stub,
      ms: Date.now() - t0, actions: actionCount(turns), tools: act.tools, answer: ctx.turn.answer, rounds: act.rounds,
      ...(budget ? { budget } : {}), ...(overflow ? { overflow } : {}),
    };
  } catch (e) {
    return errorRun(s, n, env.mode, t0, turns, e);
  } finally {
    restore();
    await client?.close().catch(() => undefined);
  }
}
