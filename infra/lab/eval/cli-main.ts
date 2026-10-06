/** Проводка CLI eval к настоящим сценариям, раннеру и диску (тело — cli-run.ts). Запускать через cli.ts. */
import { runCli } from "./cli-run.js";
import { loadScenarios } from "./load-scenarios.js";
import { writeReport } from "./report-write.js";
import { runEval } from "./runner.js";

// Серверный логгер печатает в stdout — уводим в stderr, чтобы `--json` оставался чистым JSON.
console.log = console.error;

const code = await runCli(process.argv.slice(2), {
  out: (s) => void process.stdout.write(`${s}\n`),
  err: (s) => void process.stderr.write(`${s}\n`),
  load: () => loadScenarios(),
  run: runEval,
  write: writeReport,
}).catch((e: unknown) => {
  process.stderr.write(`[eval] сбой: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  return 1;
});
process.exit(code); // детач-процессы и сокеты не должны держать CLI
