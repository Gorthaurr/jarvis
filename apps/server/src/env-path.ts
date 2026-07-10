/**
 * Поиск .env устойчиво к УСТАНОВКЕ (§универсальность). Раньше loadEnv искал только вверх от cwd/модуля
 * — это работает в dev-репо, но ломается после инсталла (запуск из C:\Program Files\…, cwd не репо).
 * Порядок кандидатов: JARVIS_ENV_PATH (явный, инсталлер) → %APPDATA%/Jarvis/.env (как dataDir) →
 * cwd/.env → ../.env → module-relative (dev-монорепо). Чистая функция — юнит-тест без диска.
 */
import { join, resolve } from "node:path";

export interface EnvPathOpts {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** dirname(fileURLToPath(import.meta.url)) вызывающего — для dev-путей вверх по дереву. */
  here?: string;
}

/** Упорядоченный список путей к .env (от самого приоритетного). Дедуп, без пустых. */
export function buildEnvCandidates(opts: EnvPathOpts = {}): string[] {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const here = opts.here ?? "";
  const out: string[] = [];
  const explicit = env.JARVIS_ENV_PATH?.trim();
  if (explicit) out.push(explicit); // явный путь (инсталлер/CI) — высший приоритет
  const appdata = env.APPDATA?.trim();
  if (appdata) out.push(join(appdata, "Jarvis", ".env")); // %APPDATA%/Jarvis/.env — куда кладёт инсталлер (как dataDir)
  out.push(resolve(cwd, ".env"), resolve(cwd, "..", ".env"));
  if (here) out.push(resolve(here, "..", "..", "..", ".env"), resolve(here, "..", "..", "..", "..", ".env"));
  // дедуп с сохранением порядка
  const seen = new Set<string>();
  return out.filter((p) => p && !seen.has(p) && (seen.add(p), true));
}

/** Первый существующий .env из кандидатов (exists инъектируется — тестируемо). */
export function findEnvFile(candidates: string[], exists: (p: string) => boolean): string | undefined {
  return candidates.find(exists);
}
