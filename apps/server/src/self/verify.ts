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

/**
 * Признак «команду не удалось ЗАПУСТИТЬ» (а не «проверка нашла ошибки»). Под shell на Windows
 * отсутствующий npx НЕ даёт ENOENT: шелл сам печатает «is not recognized» и выходит с кодом 9009 —
 * поэтому прежняя проверка «есть код ошибки и пустой вывод» на этой платформе была недостижима, и
 * ненайденный инструмент рапортовался как «тесты упали» (ревью волны I). А это разные вещи:
 * «упало» требует чинить код, «не запустилось» — среду.
 */
function looksLikeSpawnFailure(error: NodeJS.ErrnoException | null, code: number | null, out: string): boolean {
  if (error && (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")) return true;
  if (code === 127 || code === 9009) return true; // «команда не найдена»: POSIX / cmd.exe
  return /is not recognized as an internal|command not found|не является внутренней или внешней/i.test(out);
}

/**
 * 🔴 ЧИСТОЕ окружение прогона (найдено ЖИВЫМ прогоном цикла): дочерний процесс наследовал
 * `process.env` СЕРВЕРА, куда загружен `.env` владельца с боевыми настройками (тарифы площадок,
 * ключи, пути). Тесты рассчитаны на дефолты, поэтому прогон падал ВСЕГДА, независимо от правки:
 * verify не мог стать зелёным в принципе, а самоправка — состояться. И это ложный красный: код
 * исправен, ломает его конфигурация среды.
 *
 * Отдаём только системные переменные (тот же приём, что env-allowlist у MCP-детей): всё, что нужно
 * для запуска Node и инструментов, и ничего из личной конфигурации Джарвиса.
 */
const SYSTEM_ENV_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "APPDATA", "LOCALAPPDATA",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "NUMBER_OF_PROCESSORS", "OS", "LANG", "LC_ALL",
];

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SYSTEM_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  env.NODE_ENV = "test";
  env.CI = "1"; // vitest не пытается открыть интерактивный watch/UI
  return env;
}

function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string; spawnFailed: boolean; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      cmd,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true, shell: process.platform === "win32", env: cleanEnv() },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`;
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        // Убит по таймауту — прогон НЕ завершился: его результат неизвестен, а не «красный».
        const timedOut = Boolean(err && (err.killed === true || err.signal));
        resolvePromise({ code: child.exitCode, out, spawnFailed: looksLikeSpawnFailure(err, child.exitCode, out), timedOut });
      },
    );
  });
}

/**
 * Доступен ли сам инструмент прогона. 🔴 Иначе различить «команды нет» и «проверка нашла ошибки»
 * на Windows невозможно: cmd.exe под shell отдаёт ненайденную команду обычным кодом 1, а своё
 * сообщение печатает в OEM-кодировке (в UTF-8 это нечитаемый мусор — проверено живьём). Поэтому
 * спрашиваем прямо: `npx --version`. Не ответил → вся проверка НЕПРОВЕДЕНА, а не провалена.
 */
export async function toolchainAvailable(cmd = "npx", packageDir = "apps/server", rootDir = selfRepoRoot()): Promise<boolean> {
  const cwd = join(rootDir, packageDir);
  const { code } = await runCommand(cmd, ["--version"], cwd, 60_000);
  return code === 0;
}

/** Прогнать одну проверку в пакете монорепо. */
export async function runCheck(name: string, cmd: string, args: readonly string[], packageDir: string, rootDir = selfRepoRoot()): Promise<CheckResult> {
  const startedAt = Date.now();
  const cwd = join(rootDir, packageDir);
  const { code, out, spawnFailed, timedOut } = await runCommand(cmd, args, cwd, CHECK_TIMEOUT_MS);
  const tail = out.length > TAIL_CHARS ? `…${out.slice(-TAIL_CHARS)}` : out;
  // «Не запустилось» и «не дождались» — оба означают НЕПРОВЕРЕНО (ok: undefined), а не провал кода.
  const ok = spawnFailed || timedOut ? undefined : code === 0;
  const note = spawnFailed ? "команду не удалось запустить" : timedOut ? "прогон не уложился в отведённое время" : "";
  return { name, ok, tail: [note, tail.trim()].filter(Boolean).join(": "), durationMs: Date.now() - startedAt };
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
export async function verifyChanges(changedFiles: readonly string[], rootDir = selfRepoRoot()): Promise<VerifyOutcome> {
  const packages = affectedPackages(changedFiles);
  const targets = packages.length > 0 ? packages : ["apps/server"];
  // 🔴 Контроль-2: правки ВНЕ проверяемых пакетов (расширение Chrome, сайдкар, infra) не покрыты ни
  // компилятором, ни тестами — а вердикт звучал как «проверки зелёные». Владелец подтверждает,
  // опираясь на это слово, поэтому непокрытое обязано быть названо.
  const uncovered = changedFiles
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !f.startsWith("apps/server/") && !f.startsWith("apps/client/") && !f.startsWith("packages/"));
  // Среда сломана (нет npx после обновления Node, битый PATH) → честно «не проверено»: рапортовать
  // «упало» значило бы отправить Джарвиса чинить исправный код.
  if (!(await toolchainAvailable("npx", targets[0] ?? "apps/server", rootDir))) {
    return {
      ok: false,
      checks: [{ name: "проба инструментов", ok: undefined, tail: "npx недоступен в этой среде", durationMs: 0 }],
      summary: "Не смог запустить проверку: в среде нет npx — считаю НЕпроверенным (чинить надо среду, а не код).",
    };
  }
  const checks: CheckResult[] = [];
  for (const pkg of targets) {
    checks.push(await runCheck(`typecheck ${pkg}`, "npx", ["tsc", "--noEmit"], pkg, rootDir));
    checks.push(await runCheck(`tests ${pkg}`, "npx", ["vitest", "run"], pkg, rootDir));
  }
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === undefined);
  const ok = failed.length === 0 && unknown.length === 0;
  const uncoveredNote = uncovered.length > 0 ? ` ⚠️ Вне проверки остались: ${uncovered.slice(0, 5).join(", ")} — их ни компилятор, ни тесты не покрывают.` : "";
  const summary = ok
    ? `Проверки зелёные: ${checks.map((c) => c.name).join(", ")}.${uncoveredNote}`
    : [
        failed.length ? `Упало: ${failed.map((c) => c.name).join(", ")}.` : "",
        unknown.length ? `Не удалось запустить: ${unknown.map((c) => c.name).join(", ")} — считаю НЕпроверенным.` : "",
      ]
        .filter(Boolean)
        .join(" ") + uncoveredNote;
  return { ok, checks, summary };
}
