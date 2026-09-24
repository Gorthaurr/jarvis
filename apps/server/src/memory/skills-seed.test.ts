/**
 * Сид общей библиотеки навыков против НАСТОЯЩЕЙ БД (ревью 2026-09-24, T-F8).
 *
 * Живой дефект: 11 курируемых общих навыков так и не попали в таблицу `skills`, а лог рапортовал
 * «засеяно 11». `saveSkill` на отказе запроса клал навык в память процесса и возвращал запись как
 * «сохранено», сид считал её засеянной. Теперь `saveSkill` отдаёт `persisted`, а сид считает только
 * реальные записи и кричит WARN про остальные.
 *
 * Реверт-проверка: в seedSharedSkills считать `written` по любому непустому saveSkill (как было) →
 * кейс «БД отказывает» даёт 1 вместо 0.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setQueryClientForTests, query } from "../db/pool.js";
import { SHARED_USER_ID, saveSkill, seedSharedSkills, serializeLearnedSkill } from "./skills.js";

async function migration(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../../../infra/migrations/${name}`, import.meta.url)), "utf8");
}

const md = (id: string, version = 1): string =>
  serializeLearnedSkill({ id, name: `Сид ${id}`, version, when: `когда нужен ${id}`, procedure: "шаг процедуры" });

describe("seedSharedSkills: «засеяно» = реально записано в БД (T-F8)", () => {
  let db: PGlite;
  const live = {
    query: (text: string, params?: readonly unknown[]) => db.query(text, params ? [...params] : undefined),
  } as unknown as Parameters<typeof __setQueryClientForTests>[0];

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    await db.exec(await migration("0001_init.sql"));
    await db.exec(await migration("0002_seed_dev.sql"));
    await db.query("insert into users (id) values ($1) on conflict do nothing", [SHARED_USER_ID]);
  }, 60_000);

  afterAll(async () => {
    __setQueryClientForTests(null);
    await db?.close();
  });

  it("живая БД: засев пишет строку в таблицу, повтор той же версии — 0 (идемпотентно)", async () => {
    __setQueryClientForTests(live);
    expect(await seedSharedSkills([md("learned__seed-live")])).toBe(1);
    expect(await seedSharedSkills([md("learned__seed-live")])).toBe(0);
    const rows = await query("select id from skills where user_id = $1 and id = $2", [SHARED_USER_ID, "learned__seed-live"]);
    expect(rows?.rows).toHaveLength(1);
  });

  it("saveSkill отдаёт persisted: true — запись легла в БД", async () => {
    __setQueryClientForTests(live);
    const saved = await saveSkill(SHARED_USER_ID, md("learned__persist-yes"));
    expect(saved?.persisted).toBe(true);
  });

  it("БД отказывает (запрос падает) → навык лишь в памяти: persisted false, «засеяно» 0, а не ложное 1", async () => {
    __setQueryClientForTests({
      query: async () => {
        throw new Error("connection terminated");
      },
    });
    const saved = await saveSkill(SHARED_USER_ID, md("learned__persist-no"));
    expect(saved).not.toBeNull(); // фолбэк в память процесса жив (recall в этой сессии найдёт)
    expect(saved?.persisted).toBe(false);
    expect(await seedSharedSkills([md("learned__seed-dead")])).toBe(0);
  });
});
