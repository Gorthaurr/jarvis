/**
 * Токены и устройства продукта против НАСТОЯЩЕГО Postgres (PGlite, продуктовые миграции через test-db).
 * Реверт-проверки (см. отчёт): (1) убрать проверку expires_at в inspectToken — падает «истечение»;
 * (2) убрать UPDATE хвоста в rotateDeviceToken — падает «старый токен умирает после ROTATED_TAIL_MS»;
 * (3) убрать отзыв токенов в revokeDevice — падает «отзыв устройства отзывает токены».
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../db/pool.js";
import { sha256hex } from "../db/users.js";
import { createUser, setStatus } from "./accounts.js";
import { listDevices, registerDevice, revokeDevice } from "./devices.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";
import { ROTATED_TAIL_MS, revokeAllForUser, revokeToken, rotateDeviceToken } from "./tokens-lifecycle.js";
import { inspectToken, issueToken, kindOfRaw, tokenHash, touchToken, verifyToken } from "./tokens.js";

const T0 = new Date("2026-09-02T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(T0.getTime() + ms);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

let n = 0;
async function user(): Promise<string> {
  const id = await createUser({ emailHash: `tok-user-${++n}` });
  if (!id) throw new Error("пользователь не создан");
  return id;
}
async function device(userId: string, ttlMs = 365 * DAY, now = T0, deviceId?: string) {
  const t = await issueToken({ userId, kind: "device", ttlMs, now, deviceId, label: "test" });
  if (!t) throw new Error("токен не выдан");
  return t;
}

describe("product/tokens + devices (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("формат: префикс по виду + 43 символа base64url; hash = sha256(raw); kindOfRaw узнаёт префиксы", async () => {
    const u = await user();
    const d = await device(u);
    expect(d.raw).toMatch(/^jdt_[A-Za-z0-9_-]{43}$/u);
    expect(d.hash).toBe(sha256hex(d.raw));
    expect(tokenHash(` ${d.raw} `)).toBe(d.hash);
    expect(d.expiresAt.getTime()).toBe(T0.getTime() + 365 * DAY);
    expect(kindOfRaw("jdt_x")).toBe("device");
    expect(kindOfRaw("jat_x")).toBe("access");
    expect(kindOfRaw("jrt_x")).toBe("refresh");
    expect(kindOfRaw("dev-token")).toBeNull();
    expect(kindOfRaw("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBeNull();
    await expect(issueToken({ userId: u, kind: "access", ttlMs: 0 })).rejects.toThrow(/ttlMs/u);
  });

  it("verifyToken: ok с userId/kind; чужой вид → null (inspect: kind_mismatch); подмена префикса → not_found", async () => {
    const u = await user();
    const d = await device(u);
    const v = await verifyToken(d.raw, ["device"], { now: T0 });
    expect(v).toMatchObject({ userId: u, kind: "device", deviceId: null, hash: d.hash, userStatus: "active" });
    expect(v?.expiresAt?.getTime()).toBe(d.expiresAt.getTime());
    expect(await verifyToken(d.raw, ["access", "refresh"], { now: T0 })).toBeNull();
    expect((await inspectToken(d.raw, ["access"], { now: T0 })).status).toBe("kind_mismatch");
    // тот же секрет под другим префиксом — другой hash → в БД его нет
    expect((await inspectToken(`jat_${d.raw.slice(4)}`, ["access"], { now: T0 })).status).toBe("not_found");
    // строка в БД говорит «access», префикс — «device»: порча/подделка
    await query("UPDATE auth_tokens SET kind = 'access' WHERE token_hash = $1", [d.hash]);
    expect((await inspectToken(d.raw, ["device"], { now: T0 })).status).toBe("kind_mismatch");
    expect((await inspectToken("мусор", ["device"])).status).toBe("not_found");
  });

  it("истечение: за 1 мс до expires_at — ok, ровно в expires_at — null / expired", async () => {
    const u = await user();
    const d = await device(u, 1000);
    expect(await verifyToken(d.raw, ["device"], { now: at(999) })).not.toBeNull();
    expect(await verifyToken(d.raw, ["device"], { now: at(1000) })).toBeNull();
    expect((await inspectToken(d.raw, ["device"], { now: at(1000) })).status).toBe("expired");
  });

  it("last_seen_at: touchToken бампает; verifyToken бампает fire-and-forget", async () => {
    const u = await user();
    const d = await device(u);
    await touchToken(d.hash, at(HOUR));
    const r1 = await query<{ last_seen_at: Date | string }>("SELECT last_seen_at FROM auth_tokens WHERE token_hash = $1", [d.hash]);
    expect(new Date(String(r1?.rows[0]?.last_seen_at)).getTime()).toBe(at(HOUR).getTime());
    await verifyToken(d.raw, ["device"], { now: at(2 * HOUR) });
    let seen = 0;
    for (let i = 0; i < 50 && seen !== at(2 * HOUR).getTime(); i++) {
      await new Promise((r) => setTimeout(r, 10));
      const r2 = await query<{ last_seen_at: Date | string }>("SELECT last_seen_at FROM auth_tokens WHERE token_hash = $1", [d.hash]);
      seen = new Date(String(r2?.rows[0]?.last_seen_at)).getTime();
    }
    expect(seen).toBe(at(2 * HOUR).getTime());
  });

  it("revokeToken: verify → null, inspect → revoked; повторный отзыв и неизвестный hash → false", async () => {
    const u = await user();
    const d = await device(u);
    expect(await revokeToken(d.hash, { now: T0 })).toBe(true);
    expect(await verifyToken(d.raw, ["device"], { now: T0 })).toBeNull();
    expect((await inspectToken(d.raw, ["device"], { now: T0 })).status).toBe("revoked");
    expect(await revokeToken(d.hash)).toBe(false);
    expect(await revokeToken(sha256hex("нет такого"))).toBe(false);
  });

  it("revokeAllForUser: фильтр по видам, счётчик, device переживает отзыв access/refresh", async () => {
    const u = await user();
    const d = await device(u);
    const a = await issueToken({ userId: u, kind: "access", ttlMs: HOUR, now: T0 });
    const r = await issueToken({ userId: u, kind: "refresh", ttlMs: 30 * DAY, now: T0 });
    expect(a && r).toBeTruthy();
    expect(await revokeAllForUser(u, ["access", "refresh"], { now: T0 })).toBe(2);
    expect(await verifyToken(a!.raw, ["access"], { now: T0 })).toBeNull();
    expect(await verifyToken(d.raw, ["device"], { now: T0 })).not.toBeNull();
    expect(await revokeAllForUser(u, undefined, { now: T0 })).toBe(1);
    expect(await revokeAllForUser(u, [], { now: T0 })).toBe(0);
    expect(await verifyToken(d.raw, ["device"], { now: T0 })).toBeNull();
  });

  it("ротация: новый токен работает и помнит rotated_from; старый живёт ROTATED_TAIL_MS и умирает после", async () => {
    const u = await user();
    const old = await device(u);
    const T1 = at(40 * DAY);
    const fresh = await rotateDeviceToken(old.hash, 365 * DAY, { now: T1 });
    expect(fresh?.raw).toMatch(/^jdt_/u);
    expect(fresh?.expiresAt.getTime()).toBe(T1.getTime() + 365 * DAY);
    expect(await verifyToken(fresh!.raw, ["device"], { now: T1 })).toMatchObject({ userId: u });
    const row = await query<{ rotated_from: string }>("SELECT rotated_from FROM auth_tokens WHERE token_hash = $1", [fresh!.hash]);
    expect(row?.rows[0]?.rotated_from).toBe(old.hash);
    expect((await inspectToken(old.raw, ["device"], { now: new Date(T1.getTime() + ROTATED_TAIL_MS - 1) })).status).toBe("ok");
    expect((await inspectToken(old.raw, ["device"], { now: new Date(T1.getTime() + ROTATED_TAIL_MS) })).status).toBe("expired");
  });

  it("ротация НЕ продлевает старый токен, если он истекал раньше хвоста; отозванный/не-device не ротируется", async () => {
    const u = await user();
    const short = await device(u, HOUR);
    expect(await rotateDeviceToken(short.hash, 365 * DAY, { now: T0 })).not.toBeNull();
    expect((await inspectToken(short.raw, ["device"], { now: at(HOUR - 1) })).status).toBe("ok");
    expect((await inspectToken(short.raw, ["device"], { now: at(HOUR) })).status).toBe("expired");
    const revoked = await device(u);
    await revokeToken(revoked.hash);
    expect(await rotateDeviceToken(revoked.hash, DAY)).toBeNull();
    const access = await issueToken({ userId: u, kind: "access", ttlMs: HOUR, now: T0 });
    expect(await rotateDeviceToken(access!.hash, DAY)).toBeNull();
  });

  it("неактивный пользователь: blocked → user_inactive / verify null; снова active → ok", async () => {
    const u = await user();
    const d = await device(u);
    expect(await setStatus(u, "blocked")).toBe(true);
    expect((await inspectToken(d.raw, ["device"], { now: T0 })).status).toBe("user_inactive");
    expect(await verifyToken(d.raw, ["device"], { now: T0 })).toBeNull();
    await setStatus(u, "active");
    expect((await inspectToken(d.raw, ["device"], { now: T0 })).status).toBe("ok");
  });

  it("registerDevice: апсерт по (user, install) — тот же id, имя обновляется; не-UUID → null; чужой user → другой id", async () => {
    const u1 = await user();
    const u2 = await user();
    const install = "0f0f0f0f-1111-2222-3333-444444444444";
    const id = await registerDevice({ userId: u1, installId: install, name: "ноутбук", now: T0 });
    expect(id).toMatch(UUID_RE);
    expect(await registerDevice({ userId: u1, installId: install.toUpperCase(), name: "ПК", now: at(HOUR) })).toBe(id);
    const list = await listDevices(u1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, installId: install, name: "ПК", kind: "desktop", revokedAt: null });
    expect(list[0]?.lastSeenAt?.getTime()).toBe(at(HOUR).getTime());
    expect(await registerDevice({ userId: u1, installId: "не-uuid" })).toBeNull();
    const other = await registerDevice({ userId: u2, installId: install });
    expect(other).toMatch(UUID_RE);
    expect(other).not.toBe(id);
  });

  it("revokeDevice: отзывает устройство И его токены (inspect → device_revoked); чужой user → false", async () => {
    const u = await user();
    const stranger = await user();
    const devId = await registerDevice({ userId: u, installId: "12121212-3434-5656-7878-909090909090" });
    const d = await device(u, 365 * DAY, T0, devId!);
    const unrelated = await device(u);
    expect((await inspectToken(d.raw, ["device"], { now: T0 })).token?.deviceId).toBe(devId);
    expect(await revokeDevice(stranger, devId!, { now: T0 })).toEqual({ device: false, tokensRevoked: 0 });
    expect(await revokeDevice(u, devId!, { now: T0 })).toEqual({ device: true, tokensRevoked: 1 });
    expect(await verifyToken(d.raw, ["device"], { now: T0 })).toBeNull();
    expect((await inspectToken(d.raw, ["device"], { now: T0 })).status).toBe("revoked");
    expect(await verifyToken(unrelated.raw, ["device"], { now: T0 })).not.toBeNull();
    expect((await listDevices(u))[0]?.revokedAt?.getTime()).toBe(T0.getTime());
    expect(await revokeDevice(u, devId!)).toEqual({ device: false, tokensRevoked: 0 });
    // перерегистрация снимает отзыв устройства, но старый токен остаётся отозванным
    expect(await registerDevice({ userId: u, installId: "12121212-3434-5656-7878-909090909090" })).toBe(devId);
    expect((await listDevices(u))[0]?.revokedAt).toBeNull();
    expect((await inspectToken(d.raw, ["device"], { now: T0 })).status).toBe("revoked");
    // токен на ОТОЗВАННОЕ устройство (отзыв после выдачи нового токена) → device_revoked
    const late = await device(u, 365 * DAY, T0, devId!);
    await query("UPDATE devices SET revoked_at = $2 WHERE id = $1", [devId, T0.toISOString()]);
    expect((await inspectToken(late.raw, ["device"], { now: T0 })).status).toBe("device_revoked");
  });
});
