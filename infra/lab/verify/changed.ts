/** Что изменилось относительно base: определение base, изменённые тест-файлы и их раскладка по vitest-пакетам. */
import { execFileSync } from "node:child_process";
import type { FlakeTarget } from "../flake/vitest-run.js";

const git = (root: string, args: string[]): string => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

/** origin/main, иначе main; null — ни того ни другого (тогда шаги с base честно падают, а не сравнивают с чем попало). */
export function resolveBase(root: string): string | null {
  for (const ref of ["origin/main", "main"]) if (git(root, ["rev-parse", "--verify", "--quiet", ref]).trim()) return ref;
  return null;
}

export const TEST_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/u;

/** Изменённые (закоммиченные после base + рабочее дерево + неотслеживаемые) не удалённые тест-файлы, пути от корня. */
export function changedTestFiles(root: string, base: string): string[] {
  const lines = [
    ...git(root, ["diff", "--name-only", "--diff-filter=AMR", base]).split("\n"),
    ...git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ];
  return [...new Set(lines.map((s) => s.trim()).filter((p) => p && TEST_RE.test(p)))].sort();
}

const OWNERS = ["apps/server", "apps/client", "packages/shared", "packages/tools", "packages/protocol", "packages/userbots"];

/** Раскладка по vitest-проектам: пакеты — cwd пакета и путь относительно него; лаборатория — --root infra/lab. */
export function targetsForFiles(root: string, files: string[]): { targets: FlakeTarget[]; unscanned: string[] } {
  const groups = new Map<string, FlakeTarget>();
  const unscanned: string[] = [];
  for (const f of files) {
    const owner = OWNERS.find((o) => f.startsWith(`${o}/`));
    const lab = f.startsWith("infra/lab/");
    if (!owner && !lab) { unscanned.push(f); continue; }
    const id = owner ?? "infra/lab";
    const t = groups.get(id) ?? { id, cwd: owner ? `${root}/${owner}` : root, args: lab ? ["--root", "infra/lab"] : [] };
    t.args.push(owner ? f.slice(owner.length + 1) : f.slice("infra/lab/".length));
    groups.set(id, t);
  }
  return { targets: [...groups.values()], unscanned };
}
