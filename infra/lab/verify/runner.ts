/**
 * Исполнитель шагов. Знает только про интерфейс Step: gate → (exec+parse | inproc) → результат. Любое исключение шага
 * = fail с причиной (закон 1: неизвестное не бывает «зелёным»). Подряд идущие шаги одной group идут параллельно.
 */
import { runExec } from "./exec.js";
import type { Ctx, ExecResult, Step, StepOutcome, StepResult } from "./types.js";

const TAIL = 3000;

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`таймаут ${Math.round(ms / 1000)} с: ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

const byExit = (r: ExecResult): StepOutcome =>
  r.code === 0 ? { status: "pass" } : { status: "fail", reason: `код выхода ${r.code}${r.signal ? ` (${r.signal})` : ""}` };

export async function runStep(step: Step, ctx: Ctx, done: StepResult[]): Promise<StepResult> {
  const t0 = Date.now();
  const base = { id: step.id, title: step.title };
  const gated = step.gate?.(ctx, done);
  if (gated) return { ...base, ...gated, ms: 0 };
  try {
    if (step.exec) {
      const res = await runExec({ ...step.exec(ctx), timeoutMs: step.timeoutMs });
      const parsed = await (step.parse ?? byExit)(res, ctx);
      const out: StepOutcome = res.timedOut ? { ...parsed, status: "fail", reason: `таймаут ${Math.round(step.timeoutMs / 1000)} с — процесс убит` } : parsed;
      return { ...base, ...out, ms: Date.now() - t0, exitCode: res.code, timedOut: res.timedOut, outputTail: out.status === "fail" ? res.out.slice(-TAIL) : undefined };
    }
    if (step.inproc) return { ...base, ...(await withTimeout(step.inproc(ctx, done), step.timeoutMs, step.id)), ms: Date.now() - t0 };
    return { ...base, status: "fail", reason: "шаг без exec и inproc — ошибка описания шага", ms: 0 };
  } catch (e) {
    return { ...base, status: "fail", reason: `исключение: ${e instanceof Error ? e.message : String(e)}`, ms: Date.now() - t0 };
  }
}

export async function runSteps(steps: Step[], ctx: Ctx, onDone?: (r: StepResult) => void): Promise<StepResult[]> {
  const done: StepResult[] = [];
  for (let i = 0; i < steps.length; ) {
    const head = steps[i] as Step;
    let j = i + 1;
    if (head.group) while (j < steps.length && steps[j]?.group === head.group) j++;
    const batch = steps.slice(i, j);
    const results = await Promise.all(batch.map((s) => runStep(s, ctx, done)));
    for (const r of results) { done.push(r); onDone?.(r); }
    i = j;
  }
  return done;
}
