/**
 * Единый раннер проверок Джарвиса: `node --import tsx infra/lab/verify.ts [--profile quick|verify|full] [--json]`
 * (pnpm verify:quick | verify | verify:full). Состав профилей — данные в verify/steps*.ts, описание — docs/lab/VERIFY.md.
 *   --only a,b    только шаги с этими id/префиксами (отладка; отчёт в docs/lab/runs не пишется без --out)
 *   --base REF    с чем сравнивать (по умолчанию origin/main, иначе main)
 *   --out DIR     каталог отчётов (по умолчанию docs/lab/runs)
 *   --list        показать шаги профиля и выйти
 * Код выхода: 0 — нет FAIL (skip с причиной и «не проверено» видны в аудите), 1 — есть FAIL, 2 — ошибка аргументов.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBase } from "./verify/changed.js";
import { buildReport, formatSummary, writeReport } from "./verify/report.js";
import { runSteps } from "./verify/runner.js";
import { PROFILES, stepsFor } from "./verify/steps.js";
import type { Ctx, ProfileName, Step } from "./verify/types.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).split("\\").join("/").replace(/\/$/u, "");

interface Args { profile: ProfileName; json: boolean; only: string[]; base?: string; out?: string; list: boolean }

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { profile: "quick", json: false, only: [], list: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => argv[++i] ?? "";
    if (k === "--profile") {
      const p = v();
      if (!PROFILES.includes(p as ProfileName)) return `неизвестный профиль «${p}», нужен: ${PROFILES.join(" | ")}`;
      a.profile = p as ProfileName;
    } else if (k === "--json") a.json = true;
    else if (k === "--list") a.list = true;
    else if (k === "--only") a.only = v().split(",").filter(Boolean);
    else if (k === "--base") a.base = v();
    else if (k === "--out") a.out = v();
    else return `неизвестный аргумент «${k}»`;
  }
  return a;
}

export function selectSteps(profile: ProfileName, only: string[]): Step[] | string {
  const all = stepsFor(profile);
  if (!only.length) return all;
  const unknown = only.filter((o) => !all.some((s) => s.id === o || s.id.startsWith(o)));
  if (unknown.length) return `в профиле ${profile} нет шагов: ${unknown.join(", ")} (см. --list)`;
  return all.filter((s) => only.some((o) => s.id === o || s.id.startsWith(o)));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") return usage(args);
  const steps = selectSteps(args.profile, args.only);
  if (typeof steps === "string") return usage(steps);
  if (args.list) {
    for (const s of steps) console.log(`${s.id.padEnd(24)} ${Math.round(s.timeoutMs / 60_000)} мин  ${s.title}`);
    return 0;
  }
  const say = (m: string): void => void (args.json ? console.error(m) : console.log(m));
  const runsDir = args.out ?? join(ROOT, "docs/lab/runs");
  const workDir = mkdtempSync(join(tmpdir(), "jarvis-verify-"));
  const ctx: Ctx = { root: ROOT, profile: args.profile, base: args.base ?? resolveBase(ROOT), env: process.env, platform: process.platform, workDir, runsDir };
  const startedAt = new Date();
  say(`verify:${args.profile}: ${steps.length} шагов, base=${ctx.base ?? "—"}`);
  const results = await runSteps(steps, ctx, (r) => say(`[${r.status.toUpperCase()}] ${r.id} ${(r.ms / 1000).toFixed(1)}с${r.reason ? ` — ${r.reason.slice(0, 160)}` : ""}`));
  const report = buildReport({ profile: args.profile, startedAt, finishedAt: new Date(), base: ctx.base, chromePath: Boolean(process.env.CHROME_PATH), steps: results });
  const file = args.only.length && !args.out ? null : writeReport(report, runsDir);
  say(formatSummary(report));
  if (file) say(`отчёт: ${file}`);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  if (report.ok) rmSync(workDir, { recursive: true, force: true });
  else say(`артефакты упавших шагов (JSON vitest): ${workDir}`);
  return report.ok ? 0 : 1;
}

function usage(msg: string): number {
  console.error(`${msg}\nusage: node --import tsx infra/lab/verify.ts [--profile quick|verify|full] [--json] [--only id,id] [--base REF] [--out DIR] [--list]`);
  return 2;
}

// Точка входа — по realpath (запуск через junction/симлинк, Windows: argv[1] = C:\…, а import.meta.url = file:///C:/…).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
