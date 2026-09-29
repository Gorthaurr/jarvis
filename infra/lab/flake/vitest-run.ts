/** Один настоящий прогон vitest для флейк-скана → таблица исходов. Каталог пакета — cwd (как и в остальных шагах). */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runExec } from "../verify/exec.js";
import { parseVitestJson } from "../verify/parse.js";
import { vitestSpec } from "../verify/tools.js";
import type { Ctx } from "../verify/types.js";
import type { RunOutcomes } from "./scan.js";

export interface FlakeTarget {
  id: string;
  /** Каталог запуска vitest (абсолютный). */
  cwd: string;
  /** Фильтры файлов или флаги (--root ...); пусто — весь набор пакета. */
  args: string[];
}

export function vitestRunOnce(ctx: Ctx, t: FlakeTarget, timeoutMs: number): (i: number) => Promise<RunOutcomes> {
  return async (i) => {
    const jsonFile = join(ctx.workDir, `flake-${t.id.replace(/[^\w-]/gu, "_")}-${i}.json`);
    rmSync(jsonFile, { force: true }); // старый отчёт не должен сойти за свежий
    await runExec({ ...vitestSpec(ctx, { cwd: t.cwd, args: ["--passWithNoTests", ...t.args], jsonFile }), timeoutMs });
    try {
      return parseVitestJson(readFileSync(jsonFile, "utf8"), ctx.root)?.outcomes ?? new Map();
    } catch {
      return new Map(); // vitest не дожил до отчёта → пустой прогон, classify его посчитает
    }
  };
}
