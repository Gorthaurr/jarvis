/**
 * Интеграционный тест персистентности (§13) — против НАСТОЯЩЕГО Postgres+pgvector.
 *
 * Движок — PGlite (Postgres, скомпилированный в WASM): без Docker, нативной
 * установки и виртуализации. Прогоняем реальные миграции infra/migrations/* и
 * дёргаем РЕАЛЬНЫЕ функции кода (episodic/skills/action_log/usage_quota), чтобы
 * доказать: схема §13 совпадает с тем, что код фактически читает/пишет.
 *
 * Это страховка от рассинхрона «код ↔ миграция» (был keystone-дефект: каждый
 * INSERT падал на несуществующих колонках).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { SpendGuard } from "../billing/index.js";
import { HashEmbeddingProvider } from "../integrations/openai-embeddings.js";
import { PgVectorEpisodicMemory } from "../memory/episodic.js";
import { getSkill, saveSkill } from "../memory/skills.js";
import { buildActionLogEntry, insertActionLog } from "./action-log.js";
import { __setQueryClientForTests, isDbReady, query } from "./pool.js";

/** Dev-пользователь из seed (0002_seed_dev.sql). */
const DEV_USER = "00000000-0000-0000-0000-000000000001";

async function readMigration(name: string): Promise<string> {
  const url = new URL(`../../../../infra/migrations/${name}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("персистентность: схема §13 ↔ запросы кода (PGlite + pgvector)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite({ extensions: { vector } });
    // Реальные миграции — те же файлы, что лягут в нативный Postgres.
    await db.exec(await readMigration("0001_init.sql"));
    await db.exec(await readMigration("0002_seed_dev.sql"));
    // Внедряем PGlite как клиент для глобального query() (db/pool.ts).
    __setQueryClientForTests({
      query: (text, params) => db.query(text, params ? [...params] : undefined),
    });
  });

  afterAll(async () => {
    __setQueryClientForTests(null);
    await db?.close();
  });

  it("isDbReady: РЕАЛЬНЫЙ SELECT 1 против живого бэкенда → true (DB1)", async () => {
    // testClient (PGlite) внедрён в beforeAll → query('SELECT 1') отвечает успешно.
    await expect(isDbReady()).resolves.toBe(true);
  });

  it("миграции применяются: расширение vector, seed-пользователь и dev-навык на месте", async () => {
    const ext = await query("select extname from pg_extension where extname = 'vector'");
    expect(ext?.rows.length).toBe(1);
    const u = await query("select id from users where id = $1", [DEV_USER]);
    expect(u?.rows.length).toBe(1);
    const s = await query("select id from skills where user_id = $1 and id = $2", [
      DEV_USER,
      "open-browser",
    ]);
    expect(s?.rows.length).toBe(1);
  });

  it("episodic_memory: write + семантический поиск через pgvector (§8)", async () => {
    const mem = new PgVectorEpisodicMemory(new HashEmbeddingProvider(1536));
    await mem.write({ userId: DEV_USER, kind: "preference", text: "люблю кофе по утрам", ts: Date.now() });
    await mem.write({ userId: DEV_USER, kind: "fact", text: "тренировка по понедельникам в зале", ts: Date.now() });

    const hits = await mem.search(DEV_USER, "когда у меня тренировка в зале", 2);
    expect(hits.length).toBeGreaterThan(0);
    // Релевантный эпизод про тренировку должен оказаться первым.
    expect(hits[0]!.episode.text).toContain("тренировка");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("skills: saveSkill → getSkill round-trip; content_md канон + derived steps (§8)", async () => {
    const md =
      '---\nid: test-skill\nname: Тест\nversion: 2\n---\n\n## Шаги\n1. app.launch app="Notepad"\n2. input.type text="привет"\n';
    const saved = await saveSkill(DEV_USER, md);
    expect(saved).not.toBeNull();

    const got = await getSkill(DEV_USER, "test-skill");
    expect(got).not.toBeNull();
    expect(got!.contentMd).toBe(md); // канонический источник сохранён дословно
    expect(got!.version).toBe(2);
    expect(got!.steps.length).toBe(2); // derived-парс шагов
    expect(got!.steps[0]!.action).toBe("app.launch");
  });

  it("action_log: insertActionLog реально пишет строку аудита (§8)", async () => {
    const entry = buildActionLogEntry(
      "sess-int-1",
      "cmd-int-1",
      { kind: "app.launch", app: "notepad" },
      { commandId: "cmd-int-1", ok: true, durationMs: 7 },
    );
    const ok = await insertActionLog(entry);
    expect(ok).toBe(true);

    const row = await query<{ kind: string; ok: boolean }>(
      "select kind, ok from action_log where command_id = $1",
      ["cmd-int-1"],
    );
    expect(row?.rows[0]?.kind).toBe("app.launch");
    expect(row?.rows[0]?.ok).toBe(true);
  });

  it("usage_quota: SpendGuard upsert аккумулирует tokens_used/cost_estimate (§14)", async () => {
    const guard = new SpendGuard({}, { userId: DEV_USER });
    guard.recordUsage("task-int-1", 100, 0.5);
    await guard.drain();
    guard.recordUsage("task-int-2", 50, 0.25);
    await guard.drain();

    const row = await query<{ tokens_used: string; cost_estimate: string }>(
      "select tokens_used, cost_estimate from usage_quota where user_id = $1 and period = to_char(now(),'YYYY-MM')",
      [DEV_USER],
    );
    // Seed создал строку с tokens_used=0; два upsert'а аккумулируют 150 / 0.75.
    expect(Number(row?.rows[0]?.tokens_used)).toBe(150);
    expect(Number(row?.rows[0]?.cost_estimate)).toBeCloseTo(0.75, 5);
  });
});
