/**
 * Интеграция провижна пользователей + шва auth_tokens (§13, Фаза 6B / B2) против НАСТОЯЩЕГО
 * Postgres (PGlite WASM). Прогоняем реальные миграции 0001+0002+0003 и дёргаем РЕАЛЬНЫЕ функции
 * (ensureUser/recordToken/findUserByTokenHash, resolveAndProvision). Доказываем:
 *  • схема 0003 применяется и совпадает с запросами кода;
 *  • lazy-provision создаёт users ДО per-user INSERT → FK не падает (Hazard 1 закрыт);
 *  • strict-режим реально отклоняет неизвестный токен и принимает известный;
 *  • dev-путь НЕ пишет auth_tokens (континьюити-канарейка).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { ensureUser, findUserByTokenHash, recordToken, sha256hex } from "./users.js";
import { resolveAndProvision } from "../gateway/identity.js";
import { __setQueryClientForTests, query } from "./pool.js";

const DEV_USER = "00000000-0000-0000-0000-000000000001";

async function readMigration(name: string): Promise<string> {
  const url = new URL(`../../../../infra/migrations/${name}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("db/users — provision + auth_tokens (PGlite)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    await db.exec(await readMigration("0001_init.sql"));
    await db.exec(await readMigration("0002_seed_dev.sql"));
    await db.exec(await readMigration("0003_auth_tokens.sql")); // ← новая миграция B2
    __setQueryClientForTests({
      query: (text, params) => db.query(text, params ? [...params] : undefined),
    });
  });

  afterAll(async () => {
    __setQueryClientForTests(null);
    await db?.close();
  });

  it("0003 применилась: таблица auth_tokens существует (PGlite-совместима)", async () => {
    const t = await query("select table_name from information_schema.tables where table_name = 'auth_tokens'");
    expect(t?.rows.length).toBe(1);
  });

  it("ensureUser создаёт строку users; повтор идемпотентен (ON CONFLICT DO NOTHING)", async () => {
    const u = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await ensureUser(u);
    await ensureUser(u);
    const r = await query<{ n: number }>("select count(*)::int as n from users where id = $1", [u]);
    expect(r?.rows[0]?.n).toBe(1);
  });

  it("recordToken вставляет токен и апсертит last_seen (без дублей)", async () => {
    const u = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const hash = sha256hex(u);
    await ensureUser(u);
    await recordToken(u, hash);
    await recordToken(u, hash); // апсерт
    const r = await query<{ n: number }>("select count(*)::int as n from auth_tokens where token_hash = $1", [hash]);
    expect(r?.rows[0]?.n).toBe(1);
    const ls = await query<{ last_seen_at: string | null }>(
      "select last_seen_at from auth_tokens where token_hash = $1",
      [hash],
    );
    expect(ls?.rows[0]?.last_seen_at).not.toBeNull();
  });

  it("findUserByTokenHash находит активный токен; неизвестный → null", async () => {
    const u = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const hash = sha256hex(u);
    await ensureUser(u);
    await recordToken(u, hash);
    expect(await findUserByTokenHash(hash)).toBe(u);
    expect(await findUserByTokenHash(sha256hex("no-such-token"))).toBeNull();
  });

  it("истёкший токен (expires_at в прошлом) НЕ возвращается", async () => {
    const u = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const hash = sha256hex(u);
    await ensureUser(u);
    await query("insert into auth_tokens(token_hash, user_id, expires_at) values ($1,$2, now() - interval '1 day')", [
      hash,
      u,
    ]);
    expect(await findUserByTokenHash(hash)).toBeNull();
  });

  it("Hazard 1 закрыт: после resolveAndProvision per-user INSERT (episodic) НЕ падает на FK", async () => {
    const u = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const got = await resolveAndProvision(u); // дефолт (не strict) → провижн + партиция
    expect(got).toBe(u);
    const ins = await query<{ id: string }>(
      "insert into episodic_memory(user_id, kind, text) values ($1,'fact','x') returning id",
      [u],
    );
    expect(ins?.rows.length).toBe(1); // FK users(id) удовлетворён
  });

  it("конкурентный ensureUser ×10 → одна строка, без ошибки (DB-level single-flight)", async () => {
    const u = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    await Promise.all(Array.from({ length: 10 }, () => ensureUser(u)));
    const r = await query<{ n: number }>("select count(*)::int as n from users where id = $1", [u]);
    expect(r?.rows[0]?.n).toBe(1);
  });

  it("strict + БД-up + НЕТ строки токена → resolveAndProvision == null (reject 4003), users НЕ провижнится", async () => {
    const u = "12121212-1212-1212-1212-121212121212";
    const got = await resolveAndProvision(u, { JARVIS_AUTH_STRICT: "1" });
    expect(got).toBeNull();
    const r = await query<{ n: number }>("select count(*)::int as n from users where id = $1", [u]);
    expect(r?.rows[0]?.n).toBe(0); // отклонён ДО ensureUser
  });

  it("strict + БД-up + строка токена есть → принимает userId", async () => {
    const u = "34343434-3434-3434-3434-343434343434";
    await ensureUser(u);
    await recordToken(u, sha256hex(u));
    expect(await resolveAndProvision(u, { JARVIS_AUTH_STRICT: "1" })).toBe(u);
  });

  it("континьюити-канарейка: dev-token → DEV_USER и auth_tokens-строки для dev НЕ создаётся", async () => {
    expect(await resolveAndProvision("dev-token", {})).toBe(DEV_USER);
    const r = await query<{ n: number }>("select count(*)::int as n from auth_tokens where user_id = $1", [DEV_USER]);
    expect(r?.rows[0]?.n).toBe(0); // dev-путь обходит таблицу токенов
  });

  it("sha256hex — известный вектор sha256('abc')", () => {
    expect(sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
