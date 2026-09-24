/**
 * Гонка ленивой инициализации пула БД (ревью 2026-09-24, T-F8).
 *
 * Живой корень: на boot сид общей библиотеки навыков шёл ПАРАЛЛЕЛЬНО с прогревом recall и бэкфиллом
 * эмбеддингов. Первый `query()` ставил флаг `initTried` и ждал подъёма PGlite/пула, а конкурентные видели
 * флаг и получали `backend === null` — «БД нет». Все 11 курируемых навыков легли в память процесса, лог
 * рапортовал «засеяно 11», после рестарта их не было нигде.
 *
 * Тест гоняет НАСТОЯЩИЙ `db/pool.ts` с НАСТОЯЩИМ встроенным PGlite (in-memory, без диска): несколько
 * запросов до готовности бэкенда обязаны получить ответ БД, а не null.
 * Реверт-проверка: вернуть `if (initTried) return backend; initTried = true;` → второй запрос null.
 */
import { afterAll, describe, expect, it } from "vitest";
import { __setQueryClientForTests, closeDb, configureDb, query } from "./pool.js";

afterAll(async () => {
  await closeDb();
  configureDb(undefined);
});

describe("db/pool: конкурентная инициализация (T-F8)", () => {
  it("два запроса ДО готовности бэкенда — оба получают ответ БД, ни один не проваливается в no-op", async () => {
    __setQueryClientForTests(null); // именно ленивый путь по DATABASE_URL, без тест-клиента
    configureDb("pglite://memory://");
    const [a, b, c] = await Promise.all([query("select 1 as v"), query("select 2 as v"), query("select 3 as v")]);
    expect(a?.rows[0]).toMatchObject({ v: 1 });
    expect(b?.rows[0]).toMatchObject({ v: 2 });
    expect(c?.rows[0]).toMatchObject({ v: 3 });
  }, 30_000);
});
