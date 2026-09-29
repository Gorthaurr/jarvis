/**
 * Как запускать vitest/tsc БЕЗ shell и .cmd-шимов: node + JS-вход пакета (свой node_modules пакета, иначе корневой).
 * vitest всегда из каталога пакета: серверу нужен его vitest.setup.ts, а из корня подхватятся .claude/worktrees/*.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVitestJson } from "./parse.js";
import { explainSkipped, findSkipSites, type SkipSite } from "./skip-audit.js";
import type { Ctx, ExecResult, ExecSpec, StepOutcome } from "./types.js";

const NODE = process.execPath;

function jsEntry(root: string, cwd: string, mod: string, entry: string): string {
  for (const base of [cwd, root]) {
    const p = join(base, "node_modules", mod, entry);
    if (existsSync(p)) return p;
  }
  throw new Error(`не найден ${mod}/${entry} ни в ${cwd}, ни в корне`);
}

export function tscSpec(ctx: Ctx, cwd: string, project = "tsconfig.json"): Omit<ExecSpec, "timeoutMs"> {
  return { cmd: NODE, args: [jsEntry(ctx.root, cwd, "typescript", "lib/tsc.js"), "--noEmit", "-p", project], cwd };
}

export interface VitestOpts { cwd: string; args: string[]; jsonFile: string }

export function vitestSpec(ctx: Ctx, o: VitestOpts): Omit<ExecSpec, "timeoutMs"> {
  const entry = jsEntry(ctx.root, o.cwd, "vitest", "vitest.mjs");
  const args = [entry, "run", ...o.args, "--reporter=dot", "--reporter=json", `--outputFile.json=${o.jsonFile}`];
  return { cmd: NODE, args, cwd: o.cwd };
}

const SKIP_SCAN_DIRS = ["apps/server", "apps/client", "apps/extension/test", "packages", "infra"];
let sitesCache: { root: string; sites: SkipSite[] } | null = null;
const skipSites = (root: string): SkipSite[] => {
  if (sitesCache?.root !== root) sitesCache = { root, sites: findSkipSites(root, SKIP_SCAN_DIRS) };
  return sitesCache.sites;
};

export interface VitestJudge { allowZero?: boolean; zeroNote?: string }

/** Итог vitest по JSON-файлу: файл упал целиком, 0 тестов и пропуски — не «зелёное». */
export function vitestOutcome(res: ExecResult, ctx: Ctx, jsonFile: string, j: VitestJudge = {}): StepOutcome {
  if (res.timedOut) return { status: "fail", reason: "таймаут" };
  let text = "";
  try { text = readFileSync(jsonFile, "utf8"); } catch { /* нет отчёта — vitest не дожил до записи */ }
  let p = text ? parseVitestJson(text, ctx.root) : null;
  // --passWithNoTests при пустом наборе отчёта не пишет: код 0 + явная фраза vitest = честный «0 тестов», иначе — авария.
  if (!p && res.code === 0 && /No test files found/u.test(res.out)) p = parseVitestJson('{"testResults":[]}', ctx.root);
  if (!p) return { status: "fail", reason: `нет разбираемого JSON-отчёта vitest (код ${res.code})` };
  const notes: string[] = [];
  const unverified: string[] = [];
  if (p.failedTests.length) notes.push(...p.failedTests.slice(0, 15).map((t) => `упал: ${t}`));
  if (p.failedSuites.length) notes.push(...p.failedSuites.slice(0, 15).map((f) => `файл упал целиком: ${f}`));
  const skipped = explainSkipped(p.skipped, skipSites(ctx.root));
  if (p.tests.skipped) unverified.push(`${p.tests.skipped} тестов пропущено (см. skipped)`);
  if (p.tests.todo) unverified.push(`${p.tests.todo} тестов todo`);
  let status: StepOutcome["status"] = res.code === 0 && !p.failedSuites.length && !p.tests.failed ? "pass" : "fail";
  let reason: string | undefined = status === "fail" ? `код ${res.code}, упало тестов: ${p.tests.failed}, файлов: ${p.failedSuites.length}` : undefined;
  if (status === "pass" && p.tests.total === 0) {
    if (j.allowZero) unverified.push(j.zeroNote ?? "0 тестов выполнено — шаг ничего не доказал");
    else { status = "fail"; reason = "0 тестов выполнено — набор пуст, это не «зелёное»"; }
  }
  return { status, reason, tests: p.tests, skipped, notes, unverified };
}
