/** Шаги без vitest: typecheck пакетов, гейт размеров, node --test, длина функций, аудит .only. ДАННЫЕ, не ветвления. */
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { judgeFnLengths, loadFnBaseline } from "./fn-baseline.js";
import { parseFnLengths, parseNodeTest, parseTsc } from "./parse.js";
import { findOnlySites, findSkipSites } from "./skip-audit.js";
import { tscSpec } from "./tools.js";
import type { Ctx, ProfileName, Step, StepOutcome } from "./types.js";

export const PACKAGES = [
  { id: "server", dir: "apps/server" },
  { id: "client", dir: "apps/client" },
  { id: "shared", dir: "packages/shared" },
  { id: "tools", dir: "packages/tools" },
  { id: "protocol", dir: "packages/protocol" },
  { id: "userbots", dir: "packages/userbots" },
] as const;

export const ALL: ProfileName[] = ["quick", "verify", "full"];
export const VERIFY_UP: ProfileName[] = ["verify", "full"];
const MIN = 60_000;
const NODE = process.execPath;

const noBase = (c: Ctx): { status: "fail"; reason: string } | null =>
  c.base ? null : { status: "fail", reason: "нет ни origin/main, ни main — не с чем сравнивать (git fetch origin main)" };

/** node --test: без итоговых строк (# pass N) шаг не считаем зелёным. */
const nodeTestOutcome = (out: string, code: number | null): StepOutcome => {
  const t = parseNodeTest(out);
  if (!t) return { status: "fail", reason: `нет итога node --test (код ${code})` };
  const ok = code === 0 && t.failed === 0 && t.total > 0;
  return { status: ok ? "pass" : "fail", reason: ok ? undefined : `код ${code}, упало ${t.failed}, всего ${t.total}`, tests: t, unverified: t.skipped ? [`${t.skipped} тестов node:test пропущено`] : [] };
};

export const testFilesOf = (root: string, dir: string, suffix: string): string[] =>
  readdirSync(join(root, dir)).filter((f) => f.endsWith(suffix)).sort().map((f) => `${dir}/${f}`);

export const nodeTestStep = (id: string, title: string, profiles: ProfileName[], files: (c: Ctx) => string[], timeoutMs: number, gate?: Step["gate"]): Step => ({
  id, title, profiles, timeoutMs, gate,
  exec: (c) => ({ cmd: NODE, args: ["--test", "--test-reporter=tap", ...files(c)], cwd: c.root }),
  parse: (res) => nodeTestOutcome(res.out, res.code),
});

const typecheck = (id: string, dir: string): Step => ({
  id: `typecheck:${id}`, title: `tsc --noEmit ${dir}`, profiles: ALL, timeoutMs: 8 * MIN, group: "typecheck",
  exec: (c) => tscSpec(c, join(c.root, dir)),
  parse: (res) => {
    const errs = parseTsc(res.out);
    return res.code === 0 && !errs.length ? { status: "pass" } : { status: "fail", reason: `ошибок tsc: ${errs.length || "?"} (код ${res.code})`, notes: errs.slice(0, 12) };
  },
});

export const CORE_STEPS: Step[] = [
  ...PACKAGES.map((p) => typecheck(p.id, p.dir)),
  typecheck("lab", "infra/lab"),
  {
    id: "gate:module-size", title: "module-size-gate против base (модули ≤150, раздутые не растут)", profiles: ALL, timeoutMs: 2 * MIN, gate: noBase,
    exec: (c) => ({ cmd: NODE, args: [join(c.root, "apps/server/scripts/module-size-gate.mjs"), c.base ?? "", "--json"], cwd: c.root }),
    parse: (res) => {
      let rows: Array<{ path: string; violation: string | null }> = [];
      try { rows = (JSON.parse(res.out.slice(res.out.indexOf("{"))) as { rows: typeof rows }).rows; } catch { return { status: "fail", reason: `вывод гейта не разобран (код ${res.code})` }; }
      const bad = rows.filter((r) => r.violation).map((r) => r.violation as string);
      return bad.length || res.code !== 0 ? { status: "fail", reason: `нарушений: ${bad.length}`, notes: bad.slice(0, 20) } : { status: "pass", notes: [`проверено модулей: ${rows.length}`] };
    },
  },
  nodeTestStep("node-test:keeper", "node --test client-keeper (супервизор клиента)", ["quick", "verify", "full"], () => ["infra/client-keeper.test.mjs"], 3 * MIN),
  nodeTestStep("node-test:extension", "node --test расширение (настоящий Chromium)", VERIFY_UP, (c) => testFilesOf(c.root, "apps/extension/test", ".test.mjs"), 15 * MIN, (c) => {
    const p = c.env.CHROME_PATH;
    return p ? null : { status: "fail", reason: "CHROME_PATH не задан: тесты расширения без Chromium не идут — это FAIL, а не skip (укажи путь к Chromium с поддержкой --load-extension)" };
  }),
  {
    id: "fn-lengths", title: "длина функций (храповик от fn-baseline.json)", profiles: VERIFY_UP, timeoutMs: 2 * MIN,
    exec: (c) => ({ cmd: NODE, args: ["scripts/fn-lengths.mjs", "150", "src"], cwd: join(c.root, "apps/server") }),
    parse: (res) => {
      const rows = parseFnLengths(res.out);
      return rows ? judgeFnLengths(rows, loadFnBaseline()) : { status: "fail", reason: "вывод fn-lengths не разобран" };
    },
  },
  {
    id: "audit:only-skip", title: "аудит: нет закоммиченных .only; места skip описаны", profiles: ALL, timeoutMs: MIN,
    inproc: async (c) => {
      const dirs = ["apps/server", "apps/client", "apps/extension/test", "packages", "infra"];
      const only = findOnlySites(c.root, dirs);
      const skips = findSkipSites(c.root, dirs).length;
      if (only.length) return { status: "fail", reason: `.only сужает набор молча: ${only.slice(0, 5).map((s) => `${s.file}:${s.line}`).join(", ")}` };
      return { status: "pass", notes: [`мест skip/skipIf/todo в тестах: ${skips} (причины — в шагах vitest, поле skipped)`] };
    },
  },
];
