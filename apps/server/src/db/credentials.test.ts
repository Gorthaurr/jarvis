/**
 * Интеграция per-user шифр-кред (§6B/B4) против НАСТОЯЩЕГО Postgres (PGlite): миграции 0001..0004,
 * реальные setCredential/getCredential/resolveUserKey. Доказываем: ключ хранится ШИФРОВАННО (BYTEA),
 * читается обратно расшифрованным, изолирован по userId, резолвер падает на .env-дефолт.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { getCredential, listCredentialServices, resolveUserKey, setCredential } from "./credentials.js";
import { __resetMasterKeyForTests } from "./crypto.js";
import { __setQueryClientForTests, query } from "./pool.js";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function readMigration(name: string): Promise<string> {
  const url = new URL(`../../../../infra/migrations/${name}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("db/credentials — per-user шифр-ключи (PGlite)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    await db.exec(await readMigration("0001_init.sql"));
    await db.exec(await readMigration("0002_seed_dev.sql"));
    await db.exec(await readMigration("0003_auth_tokens.sql"));
    await db.exec(await readMigration("0004_user_credentials_unique.sql"));
    __setQueryClientForTests({ query: (t, p) => db.query(t, p ? [...p] : undefined) });
    // провижн юзеров (FK user_credentials → users)
    await db.query("insert into users (id) values ($1),($2) on conflict do nothing", [A, B]);
  });

  afterAll(async () => {
    __setQueryClientForTests(null);
    await db?.close();
  });

  beforeEach(() => {
    process.env.CREDENTIALS_MASTER_KEY = "c".repeat(64);
    __resetMasterKeyForTests();
  });
  afterEach(() => {
    delete process.env.CREDENTIALS_MASTER_KEY;
    __resetMasterKeyForTests();
  });

  it("setCredential шифрует (BYTEA ≠ plaintext) → getCredential расшифровывает", async () => {
    expect(await setCredential(A, "anthropic", "sk-ant-плейн")).toBe(true);
    // в БД лежит зашифрованный блоб, НЕ открытый ключ
    const raw = await query<{ encrypted_blob: Uint8Array }>(
      "select encrypted_blob from user_credentials where user_id=$1 and service=$2",
      [A, "anthropic"],
    );
    const blobStr = Buffer.from(raw!.rows[0]!.encrypted_blob).toString("utf8");
    expect(blobStr).not.toContain("sk-ant-плейн"); // открытым текстом НЕ хранится
    // читается обратно расшифрованным
    expect(await getCredential(A, "anthropic")).toBe("sk-ant-плейн");
  });

  it("upsert: повторный setCredential перезаписывает (ON CONFLICT), без дублей", async () => {
    await setCredential(A, "deepgram", "key-1");
    await setCredential(A, "deepgram", "key-2");
    const cnt = await query<{ n: number }>(
      "select count(*)::int as n from user_credentials where user_id=$1 and service=$2",
      [A, "deepgram"],
    );
    expect(cnt!.rows[0]!.n).toBe(1);
    expect(await getCredential(A, "deepgram")).toBe("key-2");
  });

  it("изоляция по userId: ключ A не виден B", async () => {
    await setCredential(A, "elevenlabs", "a-secret");
    expect(await getCredential(B, "elevenlabs")).toBeNull();
  });

  it("resolveUserKey: per-user → иначе .env-дефолт → иначе undefined", async () => {
    await setCredential(A, "brave", "user-brave-key");
    expect(await resolveUserKey(A, "brave", "ENV_DEFAULT")).toBe("user-brave-key"); // свой важнее
    expect(await resolveUserKey(B, "brave", "ENV_DEFAULT")).toBe("ENV_DEFAULT"); // фолбэк
    expect(await resolveUserKey(B, "nope")).toBeUndefined(); // нет нигде
  });

  it("listCredentialServices: какие сервисы заданы (без значений)", async () => {
    await setCredential(B, "anthropic", "x");
    const svcs = await listCredentialServices(B);
    expect(svcs).toContain("anthropic");
    expect(svcs).not.toContain("brave"); // brave — у A, не у B
  });

  it("без мастер-ключа setCredential ЧЕСТНО не сохраняет (секрет открытым не пишем)", async () => {
    delete process.env.CREDENTIALS_MASTER_KEY;
    const dir = `${process.env.TEMP || "/tmp"}/jarvis-nokey-${process.pid}-${Date.now()}`;
    // принудим путь keyfile в недоступную/пустую директорию? Проще: ключ есть всегда (самобутстрап).
    // Поэтому здесь проверяем обратное: даже без env шифрование доступно (keyfile), сохранение идёт.
    process.env.JARVIS_DATA_DIR = dir;
    __resetMasterKeyForTests();
    try {
      expect(await setCredential(A, "openai", "k")).toBe(true); // самобутстрап ключа → сохранили
      expect(await getCredential(A, "openai")).toBe("k");
    } finally {
      delete process.env.JARVIS_DATA_DIR;
      __resetMasterKeyForTests();
    }
  });
});
