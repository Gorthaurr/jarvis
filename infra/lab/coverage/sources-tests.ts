/**
 * Доказательства «покрыто тестом»: обход *.test.ts/mjs репозитория и поиск ИМЁН строк матрицы в кавычках.
 * Грубо, но честно и воспроизводимо; ложные срабатывания давим двумя правилами:
 *  1) односложные имена (act, look, window, audio) — слишком частые слова: засчитываем только в позиции вызова/имени инструмента;
 *  2) файл, упоминающий ≥ ENUMERATION_LIMIT разных имён, — перечисление (тест схем/каталога), а не проверка поведения:
 *     не засчитываем (недосчёт безопаснее пересчёта — непокрытое видно и его разбирают).
 * Тесты самой лаборатории (infra/lab) не считаем: их вклад приходит через кейсы/сценарии.
 */
import { readFileSync, readdirSync } from "node:fs";
import { ROOT } from "../lib/deps.js";
import { actionRow, type CoverLayer, intentRow, toolRow, type TestEvidence } from "./types.js";

export const ENUMERATION_LIMIT = 20;
const ROOTS = ["apps", "packages", "infra"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "data", "pgdata", ".claude", "logs"]);
const TEST_FILE = /\.test\.(?:ts|tsx|mjs|cjs|js)$/u;
const INTENT_FILE = /matchLocalIntent|matchQuickIntent|matchMediaIntent|matchSelectionIntent|LocalIntent|routeTurn|tier0/u;
const INTEGRATION_PATH = /(?:-loop|-e2e|e2e|integration|wiring|\/scenarios\/|\/gateway\/|bench|extension\/test)/u;

/** Все тестовые файлы (пути от корня репозитория, с /). */
export function listTestFiles(roots: string[] = ROOTS, base: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(`${base}/${rel}`, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && child !== "infra/lab") walk(child);
      } else if (TEST_FILE.test(e.name)) out.push(child);
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

export const layerOf = (file: string): CoverLayer => (INTEGRATION_PATH.test(file) || file.endsWith(".mjs") ? "integration" : "unit");

const QUOTE = "[\"'`]"; // класс символов регулярки: любая из трёх кавычек
const isBare = (name: string): boolean => !/[_.]/u.test(name);
const esc = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/gu, (c) => `\\${c}`);

/** Упоминает ли текст имя: обычные — в любых кавычках, односложные — только в позиции имени инструмента. */
export function mentions(text: string, name: string): boolean {
  if (!isBare(name)) return ['"', "'", "`"].some((q) => text.includes(`${q}${name}${q}`));
  return new RegExp(`(?:dispatchTool\\(\\s*|\\b(?:name|tool)\\s*:\\s*|\\.call\\(\\s*)${QUOTE}${esc(name)}${QUOTE}`, "u").test(text);
}

export interface TestScan {
  tests: TestEvidence[];
  warnings: string[];
}

export function scanTests(known: { tools: string[]; actions: string[]; intents: string[] }, files: string[] = listTestFiles(), base: string = ROOT): TestScan {
  const tests: TestEvidence[] = [];
  const enumerations: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(`${base}/${file}`, "utf8");
    } catch {
      continue;
    }
    const rows: string[] = [];
    for (const t of known.tools) if (mentions(text, t)) rows.push(toolRow(t));
    for (const a of known.actions) if (mentions(text, a)) rows.push(actionRow(a));
    if (INTENT_FILE.test(text)) for (const i of known.intents) if (new RegExp(`\\bkind(?::\\s*|\\)\\.toBe\\(\\s*)${QUOTE}${esc(i)}${QUOTE}`, "u").test(text)) rows.push(intentRow(i));
    if (rows.length === 0) continue;
    if (rows.length >= ENUMERATION_LIMIT) {
      enumerations.push(`${file} (${rows.length})`);
      continue;
    }
    tests.push({ file, layer: layerOf(file), rows });
  }
  const warnings = enumerations.length ? [`тесты-перечисления не засчитаны (≥${ENUMERATION_LIMIT} имён): ${enumerations.join(", ")}`] : [];
  return { tests, warnings };
}
