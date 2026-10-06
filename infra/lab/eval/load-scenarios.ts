/** Загрузка сценариев: каждый `infra/lab/scenarios/*.scenario.ts` экспортирует `scenarios: EvalScenario[]`. */
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../lib/deps.js";
import type { EvalScenario } from "./types.js";

export interface LoadedScenarios {
  scenarios: EvalScenario[];
  /** Файл, который не загрузился или не экспортирует массив: молча терять сценарии нельзя. */
  errors: string[];
}

export async function loadScenarios(dir: string = repoRoot("infra/lab/scenarios")): Promise<LoadedScenarios> {
  const out: LoadedScenarios = { scenarios: [], errors: [] };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".scenario.ts")).sort()) {
    try {
      const mod = (await import(pathToFileURL(`${dir}/${name}`).href)) as { scenarios?: unknown };
      if (Array.isArray(mod.scenarios)) out.scenarios.push(...(mod.scenarios as EvalScenario[]));
      else out.errors.push(`${name}: нет экспорта scenarios: EvalScenario[]`);
    } catch (e) {
      out.errors.push(`${name}: не загрузился — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
