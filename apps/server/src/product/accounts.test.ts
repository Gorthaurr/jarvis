/**
 * Аккаунты продукта против НАСТОЯЩЕГО Postgres (PGlite, продуктовые миграции через test-db).
 * Реверт-проверки (см. отчёт): (1) убрать замену email_hash в requestDeletion — падает «tombstone»;
 * (2) убрать revokeAllForUser из requestDeletion — падает «токены удалённого не работают»;
 * (3) сломать условие purge_after <= now в purgeDue — падает «purge до срока ничего не удаляет».
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../db/pool.js";
import { exportAccount, hasDeletedTombstone, purgeDue, requestDeletion } from "./accounts-lifecycle.js";
import {
  createUser, emailHash, findUserByEmailHash, getAccount, isPlausibleEmail, listUsers, markTrialUsed,
  normalizeEmail, setRole, setStatus,
} from "./accounts.js";
import { registerDevice } from "./devices.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";
import { issueToken, verifyToken } from "./tokens.js";

const T0 = new Date("2026-09-02T12:00:00Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const PEPPER = "pepper-test";

describe("product/accounts (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("normalizeEmail / isPlausibleEmail / emailHash: регистр и пробелы не меняют хеш, pepper меняет", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(isPlausibleEmail("нет собаки")).toBe(false);
    expect(isPlausibleEmail("a@b")).toBe(false);
    expect(isPlausibleEmail(`${"x".repeat(250)}@b.co`)).toBe(false);
    const h = emailHash("Foo@Example.COM", PEPPER);
    expect(h).toMatch(/^[0-9a-f]{64}$/u);
    expect(emailHash(" foo@example.com ", PEPPER)).toBe(h);
    expect(emailHash("foo@example.com", "другой")).not.toBe(h);
    expect(() => emailHash("a@b.co", "")).toThrow(/pepper/u);
  });

  it("createUser → findUserByEmailHash → getAccount; дубль email_hash → null; email_enc лежит BYTEA", async () => {
    const h = emailHash("one@test.io", PEPPER);
    const enc = Buffer.from("зашифровано-не-по-настоящему", "utf8");
    const id = await createUser({ emailHash: h, emailEnc: enc });
    expect(id).toBeTruthy();
    expect(await findUserByEmailHash(h)).toBe(id);
    expect(await getAccount(id!)).toMatchObject({ id, role: "user", status: "active", emailHash: h, deletedAt: null, trialUsedAt: null });
    expect((await getAccount(id!))?.createdAt).toBeInstanceOf(Date);
    expect(await createUser({ emailHash: h })).toBeNull();
    const raw = await query<{ email_enc: Uint8Array }>("SELECT email_enc FROM users WHERE id = $1", [id]);
    expect(Buffer.from(raw!.rows[0]!.email_enc).equals(enc)).toBe(true);
    expect(await getAccount("00000000-0000-0000-0000-00000000dead")).toBeNull();
  });

  it("setRole / setStatus / markTrialUsed (первая отметка не сдвигается); неизвестный user → false", async () => {
    const id = (await createUser({ emailHash: emailHash("two@test.io", PEPPER) }))!;
    expect(await setRole(id, "admin")).toBe(true);
    expect(await setStatus(id, "blocked")).toBe(true);
    expect(await markTrialUsed(id, T0)).toBe(true);
    expect(await markTrialUsed(id, at(DAY))).toBe(true);
    const a = await getAccount(id);
    expect(a).toMatchObject({ role: "admin", status: "blocked" });
    expect(a?.trialUsedAt?.getTime()).toBe(T0.getTime());
    const ghost = "00000000-0000-0000-0000-00000000dead";
    expect(await setRole(ghost, "admin")).toBe(false);
    expect(await setStatus(ghost, "blocked")).toBe(false);
    expect(await markTrialUsed(ghost)).toBe(false);
  });

  it("listUsers: фильтр по статусу, limit/offset, без чужих полей", async () => {
    const ids = [];
    for (const e of ["l1@t.io", "l2@t.io", "l3@t.io"]) {
      const id = (await createUser({ emailHash: emailHash(e, PEPPER) }))!;
      await setStatus(id, "deleted");
      ids.push(id);
    }
    const all = await listUsers({ status: "deleted", limit: 100 });
    expect(all.map((u) => u.id)).toEqual(expect.arrayContaining(ids));
    expect(all.every((u) => u.status === "deleted")).toBe(true);
    expect(Object.keys(all[0]!).sort()).toEqual(["createdAt", "emailHash", "id", "role", "status"]);
    const page = await listUsers({ status: "deleted", limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]?.id).toBe(all[1]?.id);
    expect(await listUsers({ status: "deleted", limit: 0 })).toHaveLength(1); // кламп к 1
  });

  it("requestDeletion: tombstone сразу, email_enc стёрт, токены отозваны, заявка на purge; повтор идемпотентен", async () => {
    const email = "gone@test.io";
    const h = emailHash(email, PEPPER);
    const id = (await createUser({ emailHash: h, emailEnc: Buffer.from("x") }))!;
    const dev = await registerDevice({ userId: id, installId: "abababab-abab-abab-abab-abababababab" });
    const dt = (await issueToken({ userId: id, kind: "device", ttlMs: 365 * DAY, now: T0, deviceId: dev! }))!;
    const atk = (await issueToken({ userId: id, kind: "access", ttlMs: DAY, now: T0 }))!;
    expect(await hasDeletedTombstone(h)).toBe(false);

    const r = await requestDeletion(id, { now: T0 });
    expect(r).toMatchObject({ ok: true, tokensRevoked: 2, alreadyRequested: false });
    expect(r.ok && r.purgeAfter.getTime()).toBe(T0.getTime() + 30 * DAY);
    const a = await getAccount(id);
    expect(a?.status).toBe("deleted");
    expect(a?.deletedAt?.getTime()).toBe(T0.getTime());
    expect(a?.emailHash).not.toBe(h);
    expect(a?.emailHash).toMatch(new RegExp(`^deleted:[0-9a-f]{64}:${id}$`, "u"));
    expect(await findUserByEmailHash(h)).toBeNull(); // адрес больше не резолвится
    expect(await hasDeletedTombstone(h)).toBe(true); // …но повторный триал на него не даём
    expect(await hasDeletedTombstone(emailHash("other@test.io", PEPPER))).toBe(false);
    const enc = await query<{ email_enc: unknown }>("SELECT email_enc FROM users WHERE id = $1", [id]);
    expect(enc?.rows[0]?.email_enc).toBeNull();
    expect(await verifyToken(dt.raw, ["device"], { now: T0 })).toBeNull();
    expect(await verifyToken(atk.raw, ["access"], { now: T0 })).toBeNull();
    // verify → null и по status='deleted'; сам ОТЗЫВ доказывает только состояние строк (реверт-проверка M3)
    const live = await query<{ n: number }>("SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    expect(live?.rows[0]?.n).toBe(0);
    const req = await query<{ purge_after: Date | string; done_at: unknown }>("SELECT purge_after, done_at FROM deletion_requests WHERE user_id = $1", [id]);
    expect(new Date(String(req?.rows[0]?.purge_after)).getTime()).toBe(T0.getTime() + 30 * DAY);
    expect(req?.rows[0]?.done_at).toBeNull();

    const again = await requestDeletion(id, { now: at(DAY) });
    expect(again).toMatchObject({ ok: true, alreadyRequested: true, tokensRevoked: 0 });
    expect(again.ok && again.purgeAfter.getTime()).toBe(T0.getTime() + 30 * DAY); // срок не сдвинулся
    expect(await requestDeletion("00000000-0000-0000-0000-00000000dead")).toEqual({ ok: false, reason: "not_found" });
  });

  it("purgeDue: до срока — 0; в срок — пользователь и всё per-user удалены каскадом", async () => {
    const h = emailHash("purge@test.io", PEPPER);
    const id = (await createUser({ emailHash: h }))!;
    await registerDevice({ userId: id, installId: "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd" });
    await issueToken({ userId: id, kind: "device", ttlMs: DAY, now: T0 });
    const r = await requestDeletion(id, { now: T0, purgeAfterDays: 1 });
    expect(r.ok).toBe(true);
    expect(await purgeDue(at(DAY - 1))).toBe(0);
    expect(await getAccount(id)).not.toBeNull();
    expect(await purgeDue(at(DAY))).toBe(1); // только этот: у предыдущего теста срок 30 дн
    expect(await getAccount(id)).toBeNull();
    expect(await hasDeletedTombstone(h)).toBe(false);
    for (const [table, col] of [["deletion_requests", "user_id"], ["devices", "user_id"], ["auth_tokens", "user_id"]]) {
      const left = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id]);
      expect(left?.rows[0]?.n, table).toBe(0);
    }
    expect(await purgeDue(at(DAY))).toBe(0);
  });

  it("exportAccount: аккаунт, устройства, токены БЕЗ хешей, строки usage_quota; неизвестный → null", async () => {
    const id = (await createUser({ emailHash: emailHash("export@test.io", PEPPER) }))!;
    const dev = await registerDevice({ userId: id, installId: "efefefef-efef-efef-efef-efefefefefef", name: "экспорт-ПК" });
    await issueToken({ userId: id, kind: "device", ttlMs: DAY, now: T0, deviceId: dev!, label: "ноут" });
    await issueToken({ userId: id, kind: "access", ttlMs: DAY, now: at(1000) });
    await query("INSERT INTO usage_quota (user_id, period, tokens_used) VALUES ($1, '2026-09', 123)", [id]);
    const ex = await exportAccount(id);
    expect(ex?.account.id).toBe(id);
    expect(ex?.devices.map((d) => d.name)).toEqual(["экспорт-ПК"]);
    expect(ex?.tokens.map((t) => t.kind)).toEqual(["device", "access"]);
    expect(ex?.tokens[0]).toMatchObject({ label: "ноут", revokedAt: null });
    for (const t of ex!.tokens) {
      expect(Object.keys(t).some((k) => /hash|raw/iu.test(k))).toBe(false);
    }
    expect(ex?.usage).toHaveLength(1);
    expect(ex?.usage[0]).toMatchObject({ period: "2026-09" });
    expect(Number(ex?.usage[0]?.tokens_used)).toBe(123);
    expect(await exportAccount("00000000-0000-0000-0000-00000000dead")).toBeNull();
  });
});
