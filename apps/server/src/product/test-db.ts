/**
 * Тестовая БД продуктового каркаса: НАСТОЯЩИЙ Postgres (PGlite WASM) + РЕАЛЬНЫЕ миграции.
 *
 * Зачем отдельный хелпер (а не копия beforeAll из db/users.test.ts в каждом файле): продуктовая схема —
 * это базовые 0001+0002+0003 ПЛЮС весь каталог infra/migrations-product/ по алфавиту. Тест, который
 * применил бы только часть, проверял бы не ту схему, на которой живёт код (FK/UNIQUE/DEFAULT — всё
 * оттуда). Один хелпер = одна правда о том, что такое «продуктовая БД» в тестах.
 *
 * Использование: `const tdb = await openProductTestDb()` в beforeAll, `await tdb.close()` в afterAll.
 * Клиент внедряется через __setQueryClientForTests → весь код продукта (query из db/pool) ходит сюда.
 * ⚠️ Каталог без единого .sql — ошибка, не «пустая схема»: молчаливый прогон на базовой схеме дал бы
 * зелёные тесты на несуществующих колонках (PGlite бросил бы позже и невнятно).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { __setQueryClientForTests } from "../db/pool.js";

/** Базовые миграции, на которые продуктовые накладываются (тот же набор, что в db/users.test.ts). */
const BASE_MIGRATIONS = ["0001_init.sql", "0002_seed_dev.sql", "0003_auth_tokens.sql"] as const;

export interface ProductTestDb {
  readonly db: PGlite;
  /** Снимает тест-клиент из pool и закрывает PGlite. */
  close(): Promise<void>;
}

function infraDir(sub: string): string {
  return fileURLToPath(new URL(`../../../../infra/${sub}/`, import.meta.url));
}

/** Имена продуктовых миграций по алфавиту (экспорт — чтобы тест мог утверждать, что применилось). */
export async function listProductMigrations(): Promise<string[]> {
  const files = await readdir(infraDir("migrations-product"));
  return files.filter((f) => f.endsWith(".sql")).sort();
}

export async function openProductTestDb(): Promise<ProductTestDb> {
  const db = new PGlite({ extensions: { vector } });
  for (const name of BASE_MIGRATIONS) {
    await db.exec(await readFile(join(infraDir("migrations"), name), "utf8"));
  }
  const product = await listProductMigrations();
  if (product.length === 0) {
    await db.close();
    throw new Error("openProductTestDb: в infra/migrations-product/ нет ни одного .sql — продуктовая схема не применена");
  }
  for (const name of product) {
    await db.exec(await readFile(join(infraDir("migrations-product"), name), "utf8"));
  }
  __setQueryClientForTests({
    query: (text, params) => db.query(text, params ? [...params] : undefined),
  });
  return {
    db,
    close: async () => {
      __setQueryClientForTests(null);
      await db.close();
    },
  };
}
