/**
 * Тело CLI eval с внедрёнными швами (загрузка сценариев, раннер, запись отчёта, вывод): чтобы отказы и коды выхода
 * проверялись юнитами без процессов и без подписки. Код выхода: 0 — всё как ожидалось; 1 — fail/error или провал контроля;
 * 2 — неверные аргументы/отказ запускать (сервер при этом НЕ поднимался).
 */
import { type EvalArgs, USAGE, parseEvalArgs, spendRefusal } from "./cli-args.js";
import type { LoadedScenarios } from "./load-scenarios.js";
import { formatTable } from "./report-table.js";
import { selectScenarios } from "./select.js";
import { controlVerdicts } from "./stats.js";
import type { EvalOptions, EvalReportX, EvalRun, EvalScenario } from "./types.js";

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  load(): Promise<LoadedScenarios>;
  run(scenarios: readonly EvalScenario[], opts: EvalOptions): Promise<EvalReportX>;
  write(rep: EvalReportX, scenarios: readonly EvalScenario[]): { md: string; json: string };
}

const listing = (all: readonly EvalScenario[]): string =>
  all.map((s) => `${s.id.padEnd(26)} ${s.liveOnly ? "live-only" : s.brain.padEnd(9)} [${s.tags.join(",")}]  ${s.title}${s.liveOnly ? `  — ${s.liveOnly}` : ""}`).join("\n");

/** Ожидание режима: off без control обязан пройти зелёным; с control — красные real-only не ошибка, зелёные — декор. */
export function exitCodeOf(rep: EvalReportX): number {
  const bad = rep.runs.filter((r) => r.outcome === "error" || (!r.control && r.outcome === "fail"));
  const decorative = controlVerdicts(rep.runs).filter((v) => !v.red);
  const matchedNothing = rep.runs.length === 0 && rep.skipped.length === 0; // --filter/--tag ничего не нашли
  return bad.length || decorative.length || matchedNothing ? 1 : 0;
}

const progress = (r: EvalRun): string => `[eval] ${r.outcome.toUpperCase().padEnd(5)} ${r.scenarioId} #${r.n} ${Math.round(r.ms / 1000)}с${r.outcome === "pass" ? "" : ` — ${r.why.slice(0, 140)}`}`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const p = parseEvalArgs(argv);
  if (!p.ok) {
    io.err(`${p.error}\n\n${USAGE}`);
    return 2;
  }
  const a: EvalArgs = p.args;
  const refusal = spendRefusal(a);
  if (refusal) {
    io.err(refusal);
    return 2;
  }
  const loaded = await io.load();
  for (const e of loaded.errors) io.err(`[сценарии] ${e}`);
  if (a.list) {
    io.out(listing(loaded.scenarios));
    return loaded.errors.length ? 1 : 0;
  }
  const plan = selectScenarios(loaded.scenarios, a);
  io.err(`[eval] мозг ${a.brain}${a.control ? " (control)" : ""}: сценариев ${plan.run.length} × ${a.n} = ${plan.run.length * a.n} прогонов, пропущено ${plan.skipped.length}${a.brain === "real" ? " — идёт по подписке владельца" : ""}`);
  const rep = await io.run(loaded.scenarios, { brain: a.brain, n: a.n, control: a.control, onRun: (r) => io.err(progress(r)), ...(a.filter ? { filter: a.filter } : {}), ...(a.tag ? { tag: a.tag } : {}), ...(a.label ? { label: a.label } : {}) });
  if (a.write) io.err(`[eval] отчёт: ${io.write(rep, loaded.scenarios).md}`);
  io.out(a.json ? JSON.stringify(rep, null, 2) : formatTable(rep));
  return loaded.errors.length ? 1 : exitCodeOf(rep);
}
