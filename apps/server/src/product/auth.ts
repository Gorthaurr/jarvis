/**
 * Вход по одноразовому коду (email-OTP, план §5.1). Код — 6 цифр, TTL 10 мин, 5 попыток; хранится ТОЛЬКО
 * sha256(salt||code): после отправки сервер кода не знает. devEcho отдаёт код в ответе ИСКЛЮЧИТЕЛЬНО для
 * /dev/product/otp в тестах — боевой вызов флага не ставит. Отправка — инжектируемый sendMail
 * (integrations/smtp.ts): у письма ТРИ исхода, и «uncertain» (SmtpUncertainError) честно доезжает до
 * клиента как «код, возможно, ушёл — запросите новый», а не как «отправлено».
 * Лимиты: 5/ч на email_hash, 20/ч на ip_hash (RateLimiter). Проверяется ПОСЛЕДНИЙ challenge адреса —
 * новый запрос делает прежние коды недействительными. Успех — одноразовый (consumed_at ставится атомарно).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { query } from "../db/pool.js";
import { createUser, emailHash, findUserByEmailHash, getAccount, isPlausibleEmail, normalizeEmail } from "./accounts.js";
import { hasDeletedTombstone } from "./accounts-lifecycle.js";
import type { RateLimiter } from "./rate-limit.js";
import { toDate, ts } from "./rows.js";

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;
export const OTP_EMAIL_LIMIT = { max: 5, windowMs: HOUR_MS } as const;
export const OTP_IP_LIMIT = { max: 20, windowMs: HOUR_MS } as const;

export type MailDelivery = "sent" | "uncertain";
export type OtpPurpose = "otp" | "delete";

function codeHash(salt: string, code: string): string {
  return createHash("sha256").update(salt, "utf8").update(code, "utf8").digest("hex");
}

export interface RequestOtpInput {
  email: string;
  pepper: string;
  limiter: RateLimiter;
  sendMail: (email: string, code: string) => Promise<MailDelivery>;
  purpose?: OtpPurpose;
  ipHash?: string;
  now?: Date;
  devEcho?: boolean;
}
export type RequestOtpResult =
  | { accepted: true; delivery: MailDelivery; challengeId: string; expiresAt: Date; code?: string }
  | { accepted: false; reason: "rate_limited"; retryAfterMs: number }
  | { accepted: false; reason: "invalid_email" | "unavailable" | "send_failed"; message: string };

export async function requestOtp(input: RequestOtpInput): Promise<RequestOtpResult> {
  if (!isPlausibleEmail(input.email)) return { accepted: false, reason: "invalid_email", message: "адрес не похож на email" };
  const email = normalizeEmail(input.email);
  const hash = emailHash(email, input.pepper);
  if (input.ipHash) {
    const ip = input.limiter.take(`otp:ip:${input.ipHash}`, OTP_IP_LIMIT);
    if (!ip.ok) return { accepted: false, reason: "rate_limited", retryAfterMs: ip.retryAfterMs };
  }
  const per = input.limiter.take(`otp:email:${hash}`, OTP_EMAIL_LIMIT);
  if (!per.ok) return { accepted: false, reason: "rate_limited", retryAfterMs: per.retryAfterMs };
  const now = input.now ?? new Date();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const ins = await query<{ id: string }>(
    `INSERT INTO auth_challenges (email_hash, purpose, code_hash, salt, expires_at, ip_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [hash, input.purpose ?? "otp", codeHash(salt, code), salt, ts(expiresAt), input.ipHash ?? null, ts(now)],
  );
  const challengeId = ins?.rows[0]?.id;
  if (!challengeId) return { accepted: false, reason: "unavailable", message: "БД не приняла код — вход сейчас недоступен" };
  let delivery: MailDelivery;
  try {
    delivery = await input.sendMail(email, code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { accepted: false, reason: "send_failed", message: `письмо с кодом не отправлено: ${msg}` };
  }
  return { accepted: true, delivery, challengeId, expiresAt, ...(input.devEcho ? { code } : {}) };
}

export interface VerifyOtpInput {
  email: string;
  code: string;
  pepper: string;
  purpose?: OtpPurpose;
  now?: Date;
  /** Деф true: первый успешный вход создаёт пользователя. */
  createIfMissing?: boolean;
  /** Шифратор адреса для email_enc (конфигурация (1) плана); null/отсутствие — адрес не хранится. */
  encryptor?: (email: string) => Buffer | null;
}
export type VerifyOtpFailure = "not_found" | "expired" | "attempts" | "mismatch" | "consumed" | "no_user" | "blocked" | "unavailable";
export type VerifyOtpResult =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; reason: VerifyOtpFailure; attemptsLeft?: number };

interface ChallengeRow {
  id: string;
  code_hash: string;
  salt: string;
  attempts: number;
  expires_at: unknown;
  consumed_at: unknown;
}

export async function verifyOtp(input: VerifyOtpInput): Promise<VerifyOtpResult> {
  const email = normalizeEmail(input.email);
  const hash = emailHash(email, input.pepper);
  const now = input.now ?? new Date();
  const res = await query<ChallengeRow>(
    `SELECT id, code_hash, salt, attempts, expires_at, consumed_at FROM auth_challenges
      WHERE email_hash = $1 AND purpose = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [hash, input.purpose ?? "otp"],
  );
  const ch = res?.rows[0];
  if (!ch) return { ok: false, reason: "not_found" };
  if (ch.consumed_at) return { ok: false, reason: "consumed" };
  const exp = toDate(ch.expires_at);
  if (!exp || exp.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (ch.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "attempts" };
  const given = Buffer.from(codeHash(ch.salt, input.code.trim()), "hex");
  const stored = Buffer.from(ch.code_hash, "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
    const upd = await query<{ attempts: number }>("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts", [ch.id]);
    const attempts = upd?.rows[0]?.attempts ?? ch.attempts + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "attempts" };
    return { ok: false, reason: "mismatch", attemptsLeft: OTP_MAX_ATTEMPTS - attempts };
  }
  const consumed = await query<{ id: string }>(
    "UPDATE auth_challenges SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id",
    [ch.id, ts(now)],
  );
  if (!consumed) return { ok: false, reason: "unavailable" };
  if (consumed.rows.length === 0) return { ok: false, reason: "consumed" }; // гонка двух verify — победил первый
  const existing = await findUserByEmailHash(hash);
  if (existing) {
    const acc = await getAccount(existing);
    if (acc && acc.status !== "active") return { ok: false, reason: "blocked" }; // код верный, но аккаунт закрыт — токены не выдаём
    return { ok: true, userId: existing, created: false };
  }
  if (input.createIfMissing === false) return { ok: false, reason: "no_user" };
  const created = await createUser({ emailHash: hash, emailEnc: input.encryptor ? input.encryptor(email) : null });
  if (created) {
    // Адрес уже был у удалённого аккаунта (tombstone): триал ему уже давали — факт переносится на новый
    // аккаунт (ревью 2026-09-02: удалить → войти заново = бесконечный триал).
    if (await hasDeletedTombstone(hash)) await query("UPDATE users SET trial_used_at = $2 WHERE id = $1 AND trial_used_at IS NULL", [created, ts(now)]);
    return { ok: true, userId: created, created: true };
  }
  const raced = await findUserByEmailHash(hash); // второй INSERT упал на UNIQUE — пользователь уже есть
  return raced ? { ok: true, userId: raced, created: false } : { ok: false, reason: "unavailable" };
}
