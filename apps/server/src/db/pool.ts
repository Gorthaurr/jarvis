/**
 * Доступ к Postgres (§13).
 *
 * Принцип: сервер должен подниматься и без БД (M0, локальная разработка).
 * Поэтому Pool — ленивый: создаётся при первом query() и только если задан
 * DATABASE_URL и установлен пакет `pg`. Любая ошибка подключения деградирует
 * в null-результат + warn, а не валит процесс. action_log пишется best-effort.
 */
import type { Pool as PgPool, QueryResult, QueryResultRow } from "pg";
import { type Logger, createLogger } from "@jarvis/shared";

const log: Logger = createLogger("db");

let pool: PgPool | null = null;
let initTried = false;
let databaseUrl: string | undefined;

/** Зарегистрировать строку подключения (вызывает bootstrap до первого query). */
export function configureDb(url: string | undefined): void {
  databaseUrl = url;
}

/**
 * Лениво поднять Pool. Возвращает null, если БД не сконфигурирована
 * или пакет pg недоступен/упал на импорте.
 */
async function getPool(): Promise<PgPool | null> {
  if (pool) return pool;
  if (initTried) return pool; // уже пробовали и не вышло — больше не спамим
  initTried = true;

  if (!databaseUrl) {
    log.warn("DATABASE_URL не задан — БД-операции работают в no-op режиме");
    return null;
  }

  try {
    // Динамический импорт: pg может быть не установлен в dev-срезе без БД.
    const pg = await import("pg");
    const Pool = pg.default?.Pool ?? pg.Pool;
    pool = new Pool({ connectionString: databaseUrl });
    pool.on("error", (e: Error) => log.error("pg pool error", e.message));
    log.info("pg pool инициализирован");
    return pool;
  } catch (e) {
    log.warn("pg недоступен — БД-операции работают в no-op режиме", errMsg(e));
    pool = null;
    return null;
  }
}

/**
 * Выполнить запрос. Возвращает null при недоступной БД либо при ошибке
 * (ошибка логируется, не пробрасывается) — вызывающий код решает, fatal это или нет.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<R> | null> {
  const p = await getPool();
  if (!p) return null;
  try {
    return await p.query<R>(text, params as unknown[] | undefined);
  } catch (e) {
    log.error("query failed", { text, error: errMsg(e) });
    return null;
  }
}

/** Готова ли БД (есть пул). Полезно для health-чека. */
export async function isDbReady(): Promise<boolean> {
  return (await getPool()) !== null;
}

/** Корректно закрыть пул при graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (!pool) return;
  try {
    await pool.end();
  } catch (e) {
    log.warn("ошибка при закрытии пула", errMsg(e));
  } finally {
    pool = null;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
