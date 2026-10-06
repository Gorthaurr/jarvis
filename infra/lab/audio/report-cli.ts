/**
 * Отчёт слуха по корпусу в файл: `apps/server/node_modules/.bin/tsx infra/lab/audio/report-cli.ts [--quick] [out.md]`
 * (из корня репозитория). Без моделей — честный отказ с причиной и код 2, а не пустой отчёт.
 */
import { writeFileSync } from "node:fs";
import { runCorpusReport } from "./corpus-report.js";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) ?? "infra/lab/audio/CORPUS_REPORT.md";
const r = await runCorpusReport({ quick: args.includes("--quick") });
if (!r.ok) {
  console.error(`отчёт не построен: ${r.reason}`);
  process.exit(2);
}
writeFileSync(out, r.markdown);
console.log(r.markdown);
process.exit(0);
