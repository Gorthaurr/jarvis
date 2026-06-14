/**
 * Доступ к Postgres (§13).
 *
 * Принцип: сервер поднимается и без БД (всё деградирует в no-op + warn, процесс
 * не падает). Бэкенд выбирается лениво по DATABASE_URL:
 *   • `pglite://<path>` или `pglite` → встроенный PGlite (Postgres+pgvector в
 *     процессе, персист на диск) — локальная разработка без установки/Docker;
 *   • `postgres://...` → реальный node-pg Pool (нативный/удалённый Postgres);
 *   • пусто → no-op (in-memory фолбэки в памяти модулей).
 * testClient (PGlite в тестах) имеет приоритет над всем.
 */
import type { QueryResult, QueryResultRow } from "pg";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("db");

/** Минимальный node-pg-совместимый клиент: и Pool, и PGlite его удовлетворяют. */
interface QueryClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/** Встроенный PGlite (минимально нужный контракт). */
interface EmbeddedPg {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  close(): Promise<void>;
  waitReady: Promise<unknown>;
}

let backend: QueryClient | null = null;
let embedded: EmbeddedPg | null = null;
let closeBackend: (() => Promise<void>) | null = null;
let initTried = false;
let databaseUrl: string | undefined;

/** Тест-сем: внедрить клиент (PGlite) для интеграционных тестов БД. Приоритет над бэкендом. */
let testClient: QueryClient | null = null;
export function __setQueryClientForTests(client: QueryClient | null): void {
  testClient = client;
}

/** Зарегистрировать строку подключения (вызывается на bootstrap до первого query). */
export function configureDb(url: string | undefined): void {
  databaseUrl = url;
}

/** Это URL встроенного PGlite? */
function isPgliteUrl(url: string): boolean {
  return url === "pglite" || url.startsWith("pglite:");
}

/** Извлечь путь datadir из `pglite://<path>` (или дефолт рядом с cwd). */
function pgliteDataDir(url: string): string {
  const stripped = url.replace(/^pglite:(\/\/)?/, "");
  return stripped || `${process.cwd()}/infra/pgdata`;
}

/** Лениво поднять бэкенд по DATABASE_URL. null — БД не сконфигурирована/недоступна. */
async function getBackend(): Promise<QueryClient | null> {
  if (testClient) return testClient;
  if (backend) return backend;
  if (initTried) return backend;
  initTried = true;

  if (!databaseUrl) {
    log.warn("DATABASE_URL не задан — БД-операции работают в no-op режиме");
    return null;
  }

  try {
    if (isPgliteUrl(databaseUrl)) {
      backend = await createEmbeddedPglite(pgliteDataDir(databaseUrl));
    } else {
      backend = await createPgPool(databaseUrl);
    }
    return backend;
  } catch (e) {
    log.warn("БД недоступна — операции работают в no-op режиме", { error: errMsg(e) });
    backend = null;
    return null;
  }
}

/** Встроенный PGlite (Postgres+pgvector в процессе, персист на диск). */
async function createEmbeddedPglite(dataDir: string): Promise<QueryClient> {
  const { PGlite } = (await import("@electric-sql/pglite")) as unknown as {
    PGlite: new (opts: { dataDir: string; extensions: Record<string, unknown> }) => EmbeddedPg;
  };
  const { vector } = (await import("@electric-sql/pglite/vector")) as unknown as {
    vector: unknown;
  };
  const db = new PGlite({ dataDir, extensions: { vector } });
  await db.waitReady;
  embedded = db;
  closeBackend = () => db.close();
  log.info("БД: встроенный PGlite (Postgres+pgvector)", { dataDir });
  return {
    query: (text, params) =>
      db.query(text, params ? [...params] : undefined) as Promise<{ rows: never[] }>,
  };
}

/** Реальный node-pg Pool (нативный/удалённый Postgres). */
async function createPgPool(connectionString: string): Promise<QueryClient> {
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString });
  pool.on("error", (e: Error) => log.error("pg pool error", e.message));
  closeBackend = () => pool.end();
  log.info("БД: node-pg pool инициализирован");
  return pool as unknown as QueryClient;
}

/**
 * Выполнить запрос. null при недоступной БД либо при ошибке (ошибка логируется,
 * не пробрасывается) — вызывающий решает, fatal это или нет.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<R> | null> {
  const b = await getBackend();
  if (!b) return null;
  try {
    return (await b.query<R>(text, params)) as QueryResult<R>;
  } catch (e) {
    log.error("query failed", { text, error: errMsg(e) });
    return null;
  }
}

/** Готова ли БД (есть бэкенд). Полезно для health-чека. */
export async function isDbReady(): Promise<boolean> {
  return (await getBackend()) !== null;
}

/** Корректно закрыть бэкенд при graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (!closeBackend) return;
  try {
    await closeBackend();
  } catch (e) {
    log.warn("ошибка при закрытии БД", errMsg(e));
  } finally {
    backend = null;
    embedded = null;
    closeBackend = null;
    initTried = false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
