/**
 * Аудит «зелёный ≠ проверено». vitest пишет пропущенные тесты БЕЗ причины, поэтому причину берём из ИСХОДНИКА теста:
 * строки со skip/skipIf/runIf/todo (условие как есть). Не нашли — так и пишем, ничего не выдумываем.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SkippedTest } from "./types.js";

export interface SkipSite { file: string; line: number; text: string }

const SITE = /\.(?:skip|skipIf|runIf|todo)\b|\bx(?:it|describe|test)\(|\b(?:t|ctx|context)\.skip\(|\{\s*skip\s*:/u;
const ONLY = /\b(?:it|test|describe|suite)\.only\s*\(/u;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/u;
const IGNORED_DIRS = new Set(["node_modules", "dist", "out", "build", ".git", ".claude", "data", "release"]);

/** Места в тестах под dirs (пути относительно root, с /), где строка подходит под pattern. */
export function findSites(root: string, dirs: string[], pattern: RegExp): SkipSite[] {
  const sites: SkipSite[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(join(dir, e.name), `${rel}/${e.name}`);
      } else if (TEST_FILE.test(e.name)) {
        readFileSync(join(dir, e.name), "utf8").split("\n").forEach((l, i) => {
          if (pattern.test(l)) sites.push({ file: `${rel}/${e.name}`, line: i + 1, text: l.trim().slice(0, 140) });
        });
      }
    }
  };
  for (const d of dirs) walk(join(root, d), d);
  return sites;
}

export const findSkipSites = (root: string, dirs: string[]): SkipSite[] => findSites(root, dirs, SITE);
/** `.only` на describe/it молча сужает набор до одного теста: зелёный при непроверенном остальном. */
export const findOnlySites = (root: string, dirs: string[]): SkipSite[] => findSites(root, dirs, ONLY);

/** Причина пропуска: условия в файле теста. Несколько мест — все (какой именно тест — vitest не говорит). */
export function explainSkipped(skipped: Array<Omit<SkippedTest, "reason">>, sites: SkipSite[]): SkippedTest[] {
  const byFile = new Map<string, SkipSite[]>();
  for (const s of sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  return skipped.map((t) => {
    const here = byFile.get(t.file);
    const reason = here?.length
      ? here.slice(0, 3).map((s) => `${s.file}:${s.line} ${s.text}`).join(" | ")
      : "причина не найдена в исходнике (динамический skip или условие вне файла теста)";
    return { ...t, reason };
  });
}
