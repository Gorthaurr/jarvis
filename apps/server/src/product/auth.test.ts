/**
 * Email-OTP против НАСТОЯЩЕГО Postgres (PGlite). Реверт-проверки (см. отчёт): (1) убрать инкремент
 * attempts на промахе — падает «5 промахов инвалидируют код»; (2) убрать проверку expires_at —
 * падает «истечение»; (3) снять ОБЕ защиты от повторного использования (ранний return по consumed_at И
 * условие consumed_at IS NULL в UPDATE) — падает «повтор кода → consumed»; по одной они страхуют друг друга.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../db/pool.js";
import { emailHash, getAccount } from "./accounts.js";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS, type MailDelivery, requestOtp, verifyOtp } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { type ProductTestDb, openProductTestDb } from "./test-db.js";

const PEPPER = "otp-pepper";
const T0 = new Date("2026-09-02T14:00:00Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

function mailbox(delivery: MailDelivery = "sent") {
  const sent: Array<{ email: string; code: string }> = [];
  return {
    sent,
    last: () => sent[sent.length - 1],
    sendMail: async (email: string, code: string): Promise<MailDelivery> => {
      sent.push({ email, code });
      return delivery;
    },
  };
}

/** Один запрос кода без лимитов (свежий лимитер) — для тестов verify. */
async function issue(email: string, now = T0, box = mailbox()) {
  const r = await requestOtp({ email, pepper: PEPPER, limiter: new RateLimiter(() => now.getTime()), sendMail: box.sendMail, now });
  if (!r.accepted) throw new Error(`requestOtp отверг: ${r.reason}`);
  return { r, code: box.last()!.code };
}

describe("product/auth — email-OTP (PGlite)", () => {
  let tdb: ProductTestDb;
  beforeAll(async () => {
    tdb = await openProductTestDb();
  });
  afterAll(async () => {
    await tdb.close();
  });

  it("requestOtp: адрес нормализуется, код 6 цифр, в ответе кода НЕТ без devEcho; в БД — только хеш с солью", async () => {
    const box = mailbox();
    const bad = await requestOtp({ email: "не email", pepper: PEPPER, limiter: new RateLimiter(), sendMail: box.sendMail });
    expect(bad).toMatchObject({ accepted: false, reason: "invalid_email" });
    expect(box.sent).toHaveLength(0);
    const r = await requestOtp({ email: "  Req@Example.COM ", pepper: PEPPER, limiter: new RateLimiter(), sendMail: box.sendMail, now: T0 });
    expect(r.accepted).toBe(true);
    if (!r.accepted) return;
    expect(r.delivery).toBe("sent");
    expect(r.expiresAt.getTime()).toBe(T0.getTime() + OTP_TTL_MS);
    expect("code" in r).toBe(false);
    expect(box.last()).toMatchObject({ email: "req@example.com" });
    expect(box.last()?.code).toMatch(/^\d{6}$/u);
    const row = await query<{ code_hash: string; salt: string; email_hash: string; purpose: string }>(
      "SELECT code_hash, salt, email_hash, purpose FROM auth_challenges WHERE id = $1", [r.challengeId]);
    expect(row?.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row?.rows[0]?.salt).toMatch(/^[0-9a-f]{32}$/u);
    expect(row?.rows[0]?.email_hash).toBe(emailHash("req@example.com", PEPPER));
    expect(row?.rows[0]?.purpose).toBe("otp");
    expect(JSON.stringify(row?.rows[0])).not.toContain(box.last()!.code);
  });

  it("devEcho отдаёт код ТОЛЬКО по флагу; uncertain и throw отправителя доезжают честно", async () => {
    const box = mailbox();
    const echo = await requestOtp({ email: "echo@t.io", pepper: PEPPER, limiter: new RateLimiter(), sendMail: box.sendMail, devEcho: true });
    expect(echo.accepted && echo.code).toBe(box.last()?.code);
    const unc = await requestOtp({ email: "unc@t.io", pepper: PEPPER, limiter: new RateLimiter(), sendMail: mailbox("uncertain").sendMail });
    expect(unc).toMatchObject({ accepted: true, delivery: "uncertain" });
    const boom = await requestOtp({
      email: "boom@t.io", pepper: PEPPER, limiter: new RateLimiter(),
      sendMail: async () => { throw new Error("SMTP 550"); },
    });
    expect(boom).toMatchObject({ accepted: false, reason: "send_failed" });
    expect(boom.accepted === false && boom.reason === "send_failed" && boom.message).toContain("SMTP 550");
  });

  it("лимиты: 5/ч на email (6-й — rate_limited, через час снова можно), 20/ч на ip", async () => {
    let t = T0.getTime();
    const limiter = new RateLimiter(() => t);
    const box = mailbox();
    const common = { pepper: PEPPER, limiter, sendMail: box.sendMail };
    for (let i = 0; i < 5; i++) expect((await requestOtp({ ...common, email: "lim@t.io" })).accepted).toBe(true);
    const sixth = await requestOtp({ ...common, email: "lim@t.io" });
    expect(sixth).toMatchObject({ accepted: false, reason: "rate_limited" });
    expect(sixth.accepted === false && sixth.reason === "rate_limited" && sixth.retryAfterMs).toBeGreaterThan(0);
    expect(box.sent).toHaveLength(5); // письмо на заблокированный запрос НЕ уходит
    t += HOUR;
    expect((await requestOtp({ ...common, email: "lim@t.io" })).accepted).toBe(true);
    for (let i = 0; i < 20; i++) expect((await requestOtp({ ...common, email: `ip${i}@t.io`, ipHash: "ip-A" })).accepted).toBe(true);
    expect(await requestOtp({ ...common, email: "ip21@t.io", ipHash: "ip-A" })).toMatchObject({ accepted: false, reason: "rate_limited" });
    expect((await requestOtp({ ...common, email: "ip21@t.io", ipHash: "ip-B" })).accepted).toBe(true);
  });

  it("verifyOtp: промахи считаются, 5-й инвалидирует код навсегда (даже верный после — attempts)", async () => {
    const { code } = await issue("miss@t.io");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyOtp({ email: "miss@t.io", code: wrong, pepper: PEPPER, now: T0 }))
        .toEqual({ ok: false, reason: "mismatch", attemptsLeft: OTP_MAX_ATTEMPTS - i });
    }
    expect(await verifyOtp({ email: "miss@t.io", code: wrong, pepper: PEPPER, now: T0 })).toEqual({ ok: false, reason: "attempts" });
    expect(await verifyOtp({ email: "miss@t.io", code, pepper: PEPPER, now: T0 })).toEqual({ ok: false, reason: "attempts" });
    const row = await query<{ attempts: number }>("SELECT attempts FROM auth_challenges WHERE email_hash = $1", [emailHash("miss@t.io", PEPPER)]);
    expect(row?.rows[0]?.attempts).toBe(OTP_MAX_ATTEMPTS);
  });

  it("истечение: за 1 мс до TTL — успех, ровно в TTL — expired", async () => {
    const a = await issue("exp1@t.io");
    expect(await verifyOtp({ email: "exp1@t.io", code: a.code, pepper: PEPPER, now: at(OTP_TTL_MS) })).toEqual({ ok: false, reason: "expired" });
    const b = await issue("exp2@t.io");
    expect(await verifyOtp({ email: "exp2@t.io", code: b.code, pepper: PEPPER, now: at(OTP_TTL_MS - 1) })).toMatchObject({ ok: true, created: true });
  });

  it("успех создаёт пользователя (email_enc через encryptor); повтор кода → consumed; второй вход → тот же userId", async () => {
    const email = "New.User@T.io";
    const { code } = await issue(email);
    const enc = Buffer.from("enc(new.user@t.io)");
    const r = await verifyOtp({ email, code: ` ${code} `, pepper: PEPPER, now: T0, encryptor: (e) => (e === "new.user@t.io" ? enc : null) });
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) return;
    expect(await getAccount(r.userId)).toMatchObject({ status: "active", role: "user", emailHash: emailHash(email, PEPPER) });
    const stored = await query<{ email_enc: Uint8Array }>("SELECT email_enc FROM users WHERE id = $1", [r.userId]);
    expect(Buffer.from(stored!.rows[0]!.email_enc).equals(enc)).toBe(true);
    expect(await verifyOtp({ email, code, pepper: PEPPER, now: at(1000) })).toEqual({ ok: false, reason: "consumed" });
    const second = await issue(email, at(2000));
    expect(await verifyOtp({ email, code: second.code, pepper: PEPPER, now: at(3000) })).toEqual({ ok: true, userId: r.userId, created: false });
  });

  it("новый запрос делает прежний код недействительным; createIfMissing:false → no_user; purpose изолирован; нет кода → not_found", async () => {
    const first = await issue("super@t.io", T0);
    const second = await issue("super@t.io", at(1000));
    expect(await verifyOtp({ email: "super@t.io", code: first.code, pepper: PEPPER, now: at(2000) })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await verifyOtp({ email: "super@t.io", code: second.code, pepper: PEPPER, now: at(2000), createIfMissing: false })).toEqual({ ok: false, reason: "no_user" });
    const del = await issue("purpose@t.io");
    await query("UPDATE auth_challenges SET purpose = 'delete' WHERE id = $1", [del.r.challengeId]);
    expect(await verifyOtp({ email: "purpose@t.io", code: del.code, pepper: PEPPER, now: T0 })).toEqual({ ok: false, reason: "not_found" });
    expect(await verifyOtp({ email: "purpose@t.io", code: del.code, pepper: PEPPER, now: T0, purpose: "delete" })).toMatchObject({ ok: true });
    expect(await verifyOtp({ email: "nobody@t.io", code: "123456", pepper: PEPPER })).toEqual({ ok: false, reason: "not_found" });
  });
});
