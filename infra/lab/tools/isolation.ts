/**
 * Изоляция данных лаборатории от боевого Джарвиса. ИМПОРТИРОВАТЬ ПЕРВЫМ в модулях, что тянут серверный код: у стора без
 * JARVIS_DATA_DIR дефолт — `cwd/data` (= данные владельца, если cwd внутри apps/server), а БД без URL — `cwd/infra/pgdata`.
 *
 * env процесса ГЛОБАЛЕН, поэтому изоляция — на воркер vitest/процесс, а не на createToolLab(): последний созданный лаб
 * «владеет» ленивыми путями. Сторы, что лаб строит сам, получают свой каталог явно (не зависят от env).
 * Возврат при close — НИКОГДА в undefined (это дефолт владельца), а в каталог-сторож внутри %TEMP%.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLazyPathsForTests } from "../../../apps/server/src/paths.js";

const fwd = (p: string): string => p.split("\\").join("/");
export const LAB_TMP_ROOT: string = fwd(join(tmpdir(), "jarvis-lab"));
const GUARD_DIR = `${LAB_TMP_ROOT}/_guard`;

const inLabRoot = (p: string | undefined): boolean => !!p && fwd(p).startsWith(`${LAB_TMP_ROOT}/`);

function apply(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.DATABASE_URL = `pglite://${dataDir}/pgdata`;
  resetLazyPathsForTests(); // ленивые пути кешируются при первом обращении — иначе уедут в прошлый каталог
}

// Ремень безопасности на ИМПОРТ: даже если лаб не создан, сторы не полезут в каталог владельца.
if (!inLabRoot(process.env.JARVIS_DATA_DIR)) apply(GUARD_DIR);

export interface LabDir {
  /** Корень прогона (ASCII, внутри %TEMP%/jarvis-lab). */
  dir: string;
  /** JARVIS_DATA_DIR прогона. */
  dataDir: string;
  /** Вернуть env к каталогу-сторожу (не к дефолту владельца). */
  release(): void;
  /** release + удалить каталог. */
  remove(): void;
}

/** Новый каталог прогона; JARVIS_DATA_DIR/DATABASE_URL указывают в него. */
export function createLabDir(prefix = "tool-"): LabDir {
  mkdirSync(LAB_TMP_ROOT, { recursive: true });
  const dir = fwd(mkdtempSync(`${LAB_TMP_ROOT}/${prefix}`));
  const dataDir = `${dir}/data`;
  apply(dataDir);
  const release = (): void => {
    if (process.env.JARVIS_DATA_DIR === dataDir) apply(GUARD_DIR);
  };
  return {
    dir,
    dataDir,
    release,
    remove() {
      release();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
