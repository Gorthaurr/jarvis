/** Тело CLI матрицы покрытия (запускать через cli.ts). */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { repoRoot } from "../lib/deps.js";
import { buildCoverage } from "./matrix.js";
import { renderMarkdown } from "./render.js";

async function main(): Promise<void> {
  console.log = console.error; // серверный логгер пишет в stdout — не мешаем отчёту
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const rep = await buildCoverage({ runCases: !argv.includes("--no-run") });
  const md = renderMarkdown(rep);
  const target = outIdx >= 0 ? argv[outIdx + 1] : argv.includes("--write") ? repoRoot("docs/lab/COVERAGE.md") : undefined;
  if (target) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, md, "utf8");
    console.error(`записано: ${target} (строк ${rep.matrix.totals.rows}, не покрыто ${rep.matrix.uncovered.length})`);
  }
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(rep, null, 2)}\n`);
  else if (!target) process.stdout.write(md);
}

void main();
