/**
 * ПРОВЕРКА СОБСТВЕННОЙ ПРАВКИ (волна I, 2026-08-31): прежде чем предлагать владельцу применить то,
 * что Джарвис изменил в себе, он обязан прогнать те же ворота, что и человек — компилятор и тесты.
 *
 * 🔴 Почему это не формальность: единственная защита от «починил одно — сломал три» у самоправки —
 * зелёный прогон. Поэтому: (а) провал прогона = честный отказ предлагать правку, а не «наверное,
 * норм»; (б) НЕ запустилось (нет pnpm/зависший процесс) — это `unknown`, тоже не «зелено»
 * (та же грань «не смог проверить ≠ проверено», что у наблюдений и доставки сообщений).
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { selfRepoRoot } from "./repo.js";

export interface CheckResult {
  name: string;
  /** true — прошло; false — упало; undefined — ЗАПУСТИТЬ не удалось (не знаем). */
  ok: boolean | undefined;
  /** Хвост вывода: без него «упало» не поддаётся разбору. */
  tail: string;
  durationMs: number;
}

/** Потолок одного прогона: тесты сервера идут ~1-2 мин, запас — на холодный старт. */
const CHECK_TIMEOUT_MS = 10 * 60_000;
const TAIL_CHARS = 2500;

function runCommand(cmd: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; spawnFailed: boolean }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      cmd,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`;
        // ENOENT/EACCES — процесс не стартовал: это «не проверили», а не «тесты упали».
        const spawnFailed = Boolean(error && typeof (error as NodeJS.ErrnoException).code === "string" && (error as NodeJS.ErrnoException).code !== "ETIMEDOUT");
        resolvePromise({ code: child.exitCode, out, spawnFailed: spawnFailed && !out.trim() });
      },
    );
  });
}

/** Прогнать одну проверку в пакете монорепо. */
export async function runCheck(name: string, cmd: string, args: readonly string[], packageDir: string): Promise<CheckResult> {
  const startedAt = Date.now();
  const cwd = join(selfRepoRoot(), packageDir);
  const { code, out, spawnFailed } = await runCommand(cmd, args, cwd, CHECK_TIMEOUT_MS);
  const tail = out.length > TAIL_CHARS ? `…${out.slice(-TAIL_CHARS)}` : out;
  return { name, ok: spawnFailed ? undefined : code === 0, tail: tail.trim(), durationMs: Date.now() - startedAt };
}

/** Какие пакеты затронуты списком изменённых файлов (тесты гоняем там, где меняли). */
export function affectedPackages(changedFiles: readonly string[]): string[] {
  const packages = new Set<string>();
  for (const f of changedFiles) {
    const p = f.replace(/\\/g, "/");
    if (p.startsWith("apps/server/")) packages.add("apps/server");
    else if (p.startsWith("apps/client/")) packages.add("apps/client");
    else if (p.startsWith("packages/")) {
      // Общий пакет ломает обе стороны — проверяем обе (дешевле, чем узнать об этом в проде).
      packages.add("apps/server");
      packages.add("apps/client");
    }
  }
  return [...packages];
}

export interface VerifyOutcome {
  /** Все проверки зелёные (единственное состояние, в котором правку можно предлагать). */
  ok: boolean;
  checks: CheckResult[];
  summary: string;
}

/** Компилятор + тесты по затронутым пакетам. Пустой список файлов → проверяем сервер (общий случай). */
export async function verifyChanges(changedFiles: readonly string[]): Promise<VerifyOutcome> {
  const packages = affectedPackages(changedFiles);
  const targets = packages.length > 0 ? packages : ["apps/server"];
  const checks: CheckResult[] = [];
  for (const pkg of targets) {
    checks.push(await runCheck(`typecheck ${pkg}`, "npx", ["tsc", "--noEmit"], pkg));
    checks.push(await runCheck(`tests ${pkg}`, "npx", ["vitest", "run"], pkg));
  }
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === undefined);
  const ok = failed.length === 0 && unknown.length === 0;
  const summary = ok
    ? `Проверки зелёные: ${checks.map((c) => c.name).join(", ")}.`
    : [
        failed.length ? `Упало: ${failed.map((c) => c.name).join(", ")}.` : "",
        unknown.length ? `Не удалось запустить: ${unknown.map((c) => c.name).join(", ")} — считаю НЕпроверенным.` : "",
      ]
        .filter(Boolean)
        .join(" ");
  return { ok, checks, summary };
}
