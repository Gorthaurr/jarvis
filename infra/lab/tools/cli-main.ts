/**
 * Тело CLI раннера кейсов инструментов (запускать через cli.ts):
 *   node --import tsx infra/lab/tools/cli.ts [--json] [--filter <подстрока id>] [--tool <coversTool>]
 * Печатает таблицу (или JSON) и завершает процесс кодом 1, если есть fail/error. skip кодом не считается.
 */
import { loadCases } from "./load-cases.js";
import { formatTable, runCases, summarize, toJson } from "./runner.js";

async function main(): Promise<void> {
  // Серверный логгер печатает в stdout — уводим в stderr, чтобы `--json` оставался чистым JSON.
  console.log = console.error;
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const filter = arg("--filter");
  const tool = arg("--tool");
  const loaded = await loadCases();
  for (const f of loaded.files) if (f.error) console.error(`[кейсы] ${f.file}: не загружен — ${f.error}`);
  const cases = loaded.cases.filter((c) => (!filter || `${c.tool}: ${c.name}`.includes(filter)) && (!tool || c.coversTool === tool));
  const results = await runCases(cases);
  process.stdout.write(`${argv.includes("--json") ? JSON.stringify(toJson(results), null, 2) : formatTable(results)}
`);
  const s = summarize(results);
  process.exit(s.fail + s.error > 0 || loaded.files.some((f) => f.error) ? 1 : 0);
}

void main();
