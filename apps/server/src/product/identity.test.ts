/**
 * Продуктовый резолвер hello-токена против НАСТОЯЩЕГО Postgres (PGlite). Реверт-проверки (см. отчёт):
 * (1) убрать ветку `policy.auth && role === "brain"` — падает «brain + dev-token → login_required»;
 * (2) убрать раннее делегирование при `!policy.enabled` — падает «мастер выключен → как сегодня»;
 * (3) сломать сравнение возраста в ротации — падает «старый токен получает rotatedToken».
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../db/pool.js";
import { DEV_USER } from "../gateway/identity.js";
import { createUser, setStatus } from "./accounts.js";
import { registerDevice, revokeDevice } from "./devices.js";
import { DEVICE_TOKEN_TTL_MS, ROTATE_AFTER_MS, resolveProductIdentity } from "./identity.js";
import { PRODUCT_OFF, resolveProductFlags } from "./policy.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";
import { ROTATED_TAIL_MS, revokeToken } from "./tokens-lifecycle.js";
import { inspectToken, issueToken, verifyToken } from "./tokens.js";

const T0 = new Date("2026-09-02T16:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(T0.getTime() + ms);
const ENV = {}; // делегированный путь не зависит от process.env машины

const on = (env: NodeJS.ProcessEnv = {}) => resolveProductFlags({ JARVIS_PRODUCT_MODE: "1", ...env });
const ALL = on();
const BRAIN = on({ JARVIS_ROLE: "brain" });

let n = 0;
async function user(): Promise<string> {
  const id = await createUser({ emailHash: `id-user-${++n}` });
  if (!id) throw new Error("пользователь не создан");
  return id;
}
async function device(userId: string, now = T0, deviceId?: string) {
  const t = await issueToken({ userId, kind: "device", ttlMs: DEVICE_TOKEN_TTL_MS, now, deviceId });
  if (!t) throw new Error("токен не выдан");
  return t;
}

describe("product/identity — resolveProductIdentity (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("мастер выключен → делегирование БЕЗ своих проверок: dev-token → DEV_USER, UUID → партиция, даже jdt_-мусор — как сегодня", async () => {
    expect(await resolveProductIdentity({ token: "dev-token" }, PRODUCT_OFF, { env: ENV })).toEqual({ ok: true, userId: DEV_USER });
    const u = "5a5a5a5a-5a5a-5a5a-5a5a-5a5a5a5a5a5a";
    expect(await resolveProductIdentity({ token: u }, PRODUCT_OFF, { env: ENV })).toEqual({ ok: true, userId: u });
    const row = await query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE id = $1", [u]);
    expect(row?.rows[0]?.n).toBe(1); // провижн как у resolveAndProvision
    expect(await resolveProductIdentity({ token: "jdt_неизвестный" }, PRODUCT_OFF, { env: ENV })).toEqual({ ok: true, userId: DEV_USER });
  });

  it("включён, роль all: dev-token → DEV_USER (как сегодня), UUID → партиция", async () => {
    expect(await resolveProductIdentity({ token: "dev-token" }, ALL, { env: ENV })).toEqual({ ok: true, userId: DEV_USER });
    const u = "6b6b6b6b-6b6b-6b6b-6b6b-6b6b6b6b6b6b";
    expect(await resolveProductIdentity({ token: u }, ALL, { env: ENV })).toEqual({ ok: true, userId: u });
  });

  it("включён, роль brain + auth: dev-token и UUID → login_required; auth выключен → как сегодня", async () => {
    const dev = await resolveProductIdentity({ token: "dev-token" }, BRAIN, { env: ENV });
    expect(dev).toMatchObject({ ok: false, code: "login_required" });
    expect(dev.ok === false && dev.message).toMatch(/device-токен/u);
    expect(await resolveProductIdentity({ token: "7c7c7c7c-7c7c-7c7c-7c7c-7c7c7c7c7c7c" }, BRAIN, { env: ENV })).toMatchObject({ ok: false, code: "login_required" });
    const noAuth = on({ JARVIS_ROLE: "brain", JARVIS_PRODUCT_AUTH: "0" });
    expect(await resolveProductIdentity({ token: "dev-token" }, noAuth, { env: ENV })).toEqual({ ok: true, userId: DEV_USER });
  });

  it("jdt_: валидный → ok с userId/deviceId, без ротации у свежего; last_seen бампается", async () => {
    const u = await user();
    const dev = await registerDevice({ userId: u, installId: "1d1d1d1d-1d1d-1d1d-1d1d-1d1d1d1d1d1d" });
    const t = await device(u, at(-DAY), dev!);
    const r = await resolveProductIdentity({ token: t.raw, installId: "1d1d1d1d-1d1d-1d1d-1d1d-1d1d1d1d1d1d" }, BRAIN, { now: T0 });
    expect(r).toEqual({ ok: true, userId: u, deviceId: dev, rotatedToken: undefined });
    let seen = 0;
    for (let i = 0; i < 50 && seen !== T0.getTime(); i++) {
      await new Promise((res) => setTimeout(res, 10));
      const row = await query<{ last_seen_at: unknown }>("SELECT last_seen_at FROM auth_tokens WHERE token_hash = $1", [t.hash]);
      seen = new Date(String(row?.rows[0]?.last_seen_at)).getTime();
    }
    expect(seen).toBe(T0.getTime());
  });

  it("jdt_: неизвестный → unauthorized; jat_/jrt_ в hello → unauthorized (не тот канал)", async () => {
    expect(await resolveProductIdentity({ token: "jdt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, ALL, { now: T0 })).toMatchObject({ ok: false, code: "unauthorized" });
    const u = await user();
    const access = await issueToken({ userId: u, kind: "access", ttlMs: HOUR, now: T0 });
    const r = await resolveProductIdentity({ token: access!.raw }, ALL, { now: T0 });
    expect(r).toMatchObject({ ok: false, code: "unauthorized" });
    expect(r.ok === false && r.message).toMatch(/jdt_/u);
    expect(await resolveProductIdentity({ token: "jrt_x" }, ALL, { now: T0 })).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("отозванный токен / отозванное устройство → device_revoked; истёкший → login_required", async () => {
    const u = await user();
    const t1 = await device(u);
    await revokeToken(t1.hash, { now: T0 });
    expect(await resolveProductIdentity({ token: t1.raw }, ALL, { now: T0 })).toMatchObject({ ok: false, code: "device_revoked" });
    const dev = await registerDevice({ userId: u, installId: "2e2e2e2e-2e2e-2e2e-2e2e-2e2e2e2e2e2e" });
    const t2 = await device(u, T0, dev!);
    await revokeDevice(u, dev!, { now: T0 });
    expect(await resolveProductIdentity({ token: t2.raw }, ALL, { now: T0 })).toMatchObject({ ok: false, code: "device_revoked" });
    const t3 = await device(u);
    const late = await resolveProductIdentity({ token: t3.raw }, ALL, { now: at(DEVICE_TOKEN_TTL_MS) });
    expect(late).toMatchObject({ ok: false, code: "login_required" });
    expect(late.ok === false && late.message).toMatch(/истёк/u);
  });

  it("заблокированный / удалённый пользователь → account_blocked с честной причиной (свой код: клиент не стирает токен и не реконнектится)", async () => {
    const u = await user();
    const t = await device(u);
    await setStatus(u, "blocked");
    const b = await resolveProductIdentity({ token: t.raw }, ALL, { now: T0 });
    expect(b).toMatchObject({ ok: false, code: "account_blocked" });
    expect(b.ok === false && b.message).toMatch(/заблокирован/u);
    await setStatus(u, "deleted");
    const d = await resolveProductIdentity({ token: t.raw }, ALL, { now: T0 });
    expect(d.ok === false && d.message).toMatch(/удалён/u);
  });

  it("ротация: токен старше 30 дн → rotatedToken (работает, наследует device); старый живёт хвост ROTATED_TAIL_MS; 29 дн — без ротации", async () => {
    const u = await user();
    const dev = await registerDevice({ userId: u, installId: "3f3f3f3f-3f3f-3f3f-3f3f-3f3f3f3f3f3f" });
    const old = await device(u, at(-ROTATE_AFTER_MS), dev!);
    // installId в другом регистре — нормализуется (registerDevice хранит lowercase)
    const r = await resolveProductIdentity({ token: old.raw, installId: "3F3F3F3F-3F3F-3f3f-3f3f-3f3f3f3f3f3f" }, ALL, { now: T0 });
    expect(r).toMatchObject({ ok: true, userId: u, deviceId: dev });
    const rotated = r.ok ? r.rotatedToken : undefined;
    expect(rotated).toMatch(/^jdt_/u);
    expect(await verifyToken(rotated!, ["device"], { now: T0 })).toMatchObject({ userId: u, deviceId: dev });
    expect((await inspectToken(old.raw, ["device"], { now: at(ROTATED_TAIL_MS - 1) })).status).toBe("ok");
    expect((await inspectToken(old.raw, ["device"], { now: at(ROTATED_TAIL_MS) })).status).toBe("expired");
    // ротированный токен свежий → повторный hello его не ротирует
    const again = await resolveProductIdentity({ token: rotated!, installId: "3f3f3f3f-3f3f-3f3f-3f3f-3f3f3f3f3f3f" }, ALL, { now: at(HOUR) });
    expect(again).toEqual({ ok: true, userId: u, deviceId: dev, rotatedToken: undefined });
    // привязанный токен БЕЗ installId → login_required (привязка не обходится неотправкой поля); чужой installId — тоже;
    // dev-сессия текст-драйвера — исключение (и наследника она не минтит)
    expect(await resolveProductIdentity({ token: rotated! }, ALL, { now: at(HOUR) })).toMatchObject({ ok: false, code: "login_required" });
    expect(await resolveProductIdentity({ token: rotated!, installId: "9999-other" }, ALL, { now: at(HOUR) })).toMatchObject({ ok: false, code: "login_required" });
    expect(await resolveProductIdentity({ token: rotated! }, ALL, { now: at(HOUR), devSession: true })).toMatchObject({ ok: true, userId: u });
    const oldDev = await device(u, at(-ROTATE_AFTER_MS), dev!);
    const viaDriver = await resolveProductIdentity({ token: oldDev.raw }, ALL, { now: T0, devSession: true });
    expect(viaDriver).toMatchObject({ ok: true, userId: u });
    expect(viaDriver.ok && viaDriver.rotatedToken).toBeUndefined();
    const young = await device(u, at(-ROTATE_AFTER_MS + DAY));
    expect(await resolveProductIdentity({ token: young.raw }, ALL, { now: T0 })).toEqual({ ok: true, userId: u, deviceId: undefined, rotatedToken: undefined });
  });
});
