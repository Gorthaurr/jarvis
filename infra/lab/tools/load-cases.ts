/**
 * Загрузка кейсов из `infra/lab/tools/cases/*.cases.ts` (именованный экспорт `cases: ToolCase[]`).
 * Общий для CLI раннера, vitest-адаптера и матрицы покрытия.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ToolCase } from "./case-format.js";

export const CASES_DIR: string = fileURLToPath(new URL("./cases/", import.meta.url)).split("\\").join("/");

export interface LoadedCases {
  cases: ToolCase[];
  /** Файл → сколько кейсов дал; сбои импорта — сюда же, а не молча в никуда. */
  files: Array<{ file: string; count: number; error?: string }>;
}

export async function loadCases(dir: string = CASES_DIR): Promise<LoadedCases> {
  const out: LoadedCases = { cases: [], files: [] };
  const names = readdirSync(dir).filter((f) => f.endsWith(".cases.ts")).sort();
  for (const file of names) {
    try {
      const mod = (await import(pathToFileURL(`${dir.replace(/\/$/u, "")}/${file}`).href)) as { cases?: unknown };
      if (!Array.isArray(mod.cases)) throw new Error("нет именованного экспорта `cases: ToolCase[]`");
      out.cases.push(...(mod.cases as ToolCase[]));
      out.files.push({ file, count: mod.cases.length });
    } catch (e) {
      out.files.push({ file, count: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
