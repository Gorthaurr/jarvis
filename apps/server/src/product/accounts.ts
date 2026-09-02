/**
 * Аккаунты продукта (план §5.1): email хранится ТОЛЬКО HMAC-хешем с pepper (утечка таблицы не даёт
 * словарной атаки по адресам; pepper — аргумент: вызывающий берёт JARVIS_EMAIL_PEPPER или производную
 * мастер-ключа), зашифрованный адрес (email_enc, AES-GCM из db/crypto) — только если конфигурация (1)
 * плана его включила. Колонка users.email (0001) в продукте не пишется.
 *
 * Всё null-безопасно по контракту db/pool: без БД — null/false/[] и лог, НЕ ложный успех (createUser без
 * строки в БД = пользователя нет). Удаление / purge / экспорт — accounts-lifecycle.ts.
 */
import { createHmac, randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { toDate, ts } from "./rows.js";

export type UserRole = "user" | "admin";
export type UserStatus = "active" | "blocked" | "deleted";

export interface Account {
  id: string;
  role: UserRole;
  status: UserStatus;
  emailHash: string | null;
  createdAt: Date | null;
  deletedAt: Date | null;
  trialUsedAt: Date | null;
}
export type AccountSummary = Pick<Account, "id" | "role" | "status" | "createdAt" | "emailHash">;

interface UserRow {
  id: string;
  role: string;
  status: string;
  email_hash: string | null;
  created_at: unknown;
  deleted_at: unknown;
  trial_used_at: unknown;
}

const ACCOUNT_COLS = "id, role, status, email_hash, created_at, deleted_at, trial_used_at";

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

/** Правдоподобный адрес. Полную RFC-валидацию не делаем: единственный верификатор адреса — письмо с кодом. */
export function isPlausibleEmail(s: string): boolean {
  const e = normalizeEmail(s);
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(e);
}

/** HMAC-SHA256(pepper, normalizeEmail(email)) hex. Пустой pepper — ошибка конфигурации, не молчаливый слабый хеш. */
export function emailHash(email: string, pepper: string): string {
  if (!pepper) throw new Error("emailHash: пустой pepper — хеш без секрета словарно атакуем");
  return createHmac("sha256", pepper).update(normalizeEmail(email), "utf8").digest("hex");
}

export async function findUserByEmailHash(hash: string): Promise<string | null> {
  const res = await query<{ id: string }>("SELECT id FROM users WHERE email_hash = $1 LIMIT 1", [hash]);
  return res?.rows[0]?.id ?? null;
}

/** Создать пользователя → userId. null — БД недоступна ИЛИ email_hash уже занят (UNIQUE): оба «не создан». */
export async function createUser(input: { emailHash: string; emailEnc?: Buffer | null; role?: UserRole }): Promise<string | null> {
  const id = randomUUID();
  const res = await query<{ id: string }>(
    "INSERT INTO users (id, email_hash, email_enc, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id",
    [id, input.emailHash, input.emailEnc ?? null, input.role ?? "user"],
  );
  return res?.rows[0]?.id ?? null;
}

function mapAccount(r: UserRow): Account {
  return {
    id: r.id,
    role: r.role === "admin" ? "admin" : "user",
    status: r.status === "blocked" || r.status === "deleted" ? r.status : "active",
    emailHash: r.email_hash,
    createdAt: toDate(r.created_at),
    deletedAt: toDate(r.deleted_at),
    trialUsedAt: toDate(r.trial_used_at),
  };
}

export async function getAccount(userId: string): Promise<Account | null> {
  const res = await query<UserRow>(`SELECT ${ACCOUNT_COLS} FROM users WHERE id = $1`, [userId]);
  const row = res?.rows[0];
  return row ? mapAccount(row) : null;
}

/** true — строка обновлена; false — пользователя нет / БД недоступна. */
export async function setRole(userId: string, role: UserRole): Promise<boolean> {
  const res = await query<{ id: string }>("UPDATE users SET role = $2 WHERE id = $1 RETURNING id", [userId, role]);
  return (res?.rows.length ?? 0) > 0;
}

export async function setStatus(userId: string, status: UserStatus): Promise<boolean> {
  const res = await query<{ id: string }>("UPDATE users SET status = $2 WHERE id = $1 RETURNING id", [userId, status]);
  return (res?.rows.length ?? 0) > 0;
}

/** Отметить использованный триал; повтор НЕ сдвигает первую отметку (COALESCE). */
export async function markTrialUsed(userId: string, now = new Date()): Promise<boolean> {
  const res = await query<{ id: string }>(
    "UPDATE users SET trial_used_at = COALESCE(trial_used_at, $2) WHERE id = $1 RETURNING id",
    [userId, ts(now)],
  );
  return (res?.rows.length ?? 0) > 0;
}

export interface ListUsersOptions {
  limit?: number;
  offset?: number;
  status?: UserStatus;
}

/** Постраничный список (admin). limit клампится в [1, 500]. */
export async function listUsers(opts: ListUsersOptions = {}): Promise<AccountSummary[]> {
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const params: unknown[] = [limit, offset];
  let where = "";
  if (opts.status) {
    where = " WHERE status = $3";
    params.push(opts.status);
  }
  const res = await query<UserRow>(
    `SELECT ${ACCOUNT_COLS} FROM users${where} ORDER BY created_at, id LIMIT $1 OFFSET $2`,
    params,
  );
  return (res?.rows ?? []).map((r) => {
    const a = mapAccount(r);
    return { id: a.id, role: a.role, status: a.status, createdAt: a.createdAt, emailHash: a.emailHash };
  });
}
