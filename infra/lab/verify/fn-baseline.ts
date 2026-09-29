/**
 * Гейт длины функций как «храповик»: fn-lengths.mjs находит 11 старых функций > 150 строк (долг, зафиксирован в
 * fn-baseline.json). Красное — только НОВАЯ длинная функция или рост старой; старые без запроса не рефакторим.
 */
import { readFileSync } from "node:fs";
import type { FnLengthRow } from "./parse.js";
import type { StepOutcome } from "./types.js";

export type FnBaseline = Record<string, number>;

export const loadFnBaseline = (): FnBaseline =>
  JSON.parse(readFileSync(new URL("./fn-baseline.json", import.meta.url), "utf8")) as FnBaseline;

export function judgeFnLengths(rows: FnLengthRow[], baseline: FnBaseline): StepOutcome {
  const bad: string[] = [];
  const debt: string[] = [];
  const shrunk: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.file}::${r.name}`;
    seen.add(key);
    const was = baseline[key];
    if (was === undefined) bad.push(`новая длинная функция ${key}: ${r.lines} строк`);
    else if (r.lines > was) bad.push(`${key} выросла ${was} → ${r.lines}`);
    else {
      debt.push(`${key}: ${r.lines}`);
      if (r.lines < was) shrunk.push(`${key}: ${was} → ${r.lines} (обнови fn-baseline.json)`);
    }
  }
  for (const k of Object.keys(baseline)) if (!seen.has(k)) shrunk.push(`${k} больше не длиннее порога (убери из fn-baseline.json)`);
  const notes = [`известный долг: ${debt.length} функций > 150 строк`, ...shrunk];
  return bad.length ? { status: "fail", reason: bad.join("; "), notes } : { status: "pass", notes };
}
