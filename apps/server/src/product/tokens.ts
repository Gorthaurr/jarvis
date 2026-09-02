/**
 * Device/access/refresh-токены продукта (план §5.1): opaque + sha256 в БД (прецедент 0003), префиксы
 * jdt_/jat_/jrt_ — чтобы secret-scanner'ы узнавали утечку, а резолвер маршрутизировал ДО проверки UUID.
 *
 * ЧЕСТНОСТЬ: issueToken без БД отдаёт null, а не «выданный» токен, который никто не сможет проверить.
 * verifyToken отвечает null на ЛЮБОЙ отказ (HTTP-слою достаточно); inspectToken — с причиной: gateway
 * различает «устройство отозвано» и «не найден» (клиенту это разные ответы). Время инжектируется (now) —
 * тесты двигают его, а не ждут. Ротация/отзыв — tokens-lifecycle.ts, устройства — devices.ts.
 */
import { randomBytes } from "node:crypto";
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";
import { sha256hex } from "../db/users.js";
import { toDate, ts } from "./rows.js";

const log: Logger = createLogger("product:tokens");

export type TokenKind = "device" | "access" | "refresh";
export const TOKEN_PREFIX: Readonly<Record<TokenKind, string>> = { device: "jdt_", access: "jat_", refresh: "jrt_" };
const KIND_BY_PREFIX: ReadonlyMap<string, TokenKind> = new Map(
  (Object.keys(TOKEN_PREFIX) as TokenKind[]).map((k) => [TOKEN_PREFIX[k], k]),
);

/** Вид токена по префиксу; null — не продуктовый токен (UUID / dev-token / мусор). */
export function kindOfRaw(raw: string): TokenKind | null {
  return KIND_BY_PREFIX.get(raw.trim().slice(0, 4)) ?? null;
}

/** sha256(raw) hex — то, что лежит в auth_tokens.token_hash. */
export function tokenHash(raw: string): string {
  return sha256hex(raw.trim());
}

export interface IssueTokenInput {
  userId: string;
  kind: TokenKind;
  ttlMs: number;
  deviceId?: string;
  label?: string;
  ipHash?: string;
  rotatedFrom?: string;
  now?: Date;
}
export interface IssuedToken {
  raw: string;
  hash: string;
  expiresAt: Date;
}

/** Выдать токен: 32 случайных байта base64url за префиксом. null — БД не приняла (токена НЕТ). */
export async function issueToken(input: IssueTokenInput): Promise<IssuedToken | null> {
  if (!(input.ttlMs > 0)) throw new Error(`issueToken: ttlMs должен быть > 0 (получено ${input.ttlMs})`);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const raw = TOKEN_PREFIX[input.kind] + randomBytes(32).toString("base64url");
  const hash = tokenHash(raw);
  const res = await query<{ token_hash: string }>(
    `INSERT INTO auth_tokens (token_hash, user_id, kind, device_id, label, ip_hash, rotated_from, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING token_hash`,
    [hash, input.userId, input.kind, input.deviceId ?? null, input.label ?? null, input.ipHash ?? null, input.rotatedFrom ?? null, ts(now), ts(expiresAt)],
  );
  if (!res?.rows.length) {
    log.warn("токен НЕ выдан: БД не приняла запись", { userId: input.userId, kind: input.kind });
    return null;
  }
  return { raw, hash, expiresAt };
}

export type TokenStatus = "ok" | "not_found" | "kind_mismatch" | "revoked" | "device_revoked" | "expired" | "user_inactive" | "unavailable";
export interface TokenInfo {
  userId: string;
  kind: TokenKind;
  deviceId: string | null;
  hash: string;
  createdAt: Date;
  expiresAt: Date | null;
  userStatus: string;
}
export interface TokenInspection {
  status: TokenStatus;
  token?: TokenInfo;
}

interface TokenRow {
  token_hash: string;
  user_id: string;
  kind: string;
  device_id: string | null;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  device_revoked_at: unknown;
  user_status: string;
}

/** Проверка С ПРИЧИНОЙ отказа (last_seen не бампает). kinds — виды, допустимые для канала вызывающего. */
export async function inspectToken(raw: string, kinds: readonly TokenKind[], opts?: { now?: Date }): Promise<TokenInspection> {
  const kind = kindOfRaw(raw);
  if (!kind) return { status: "not_found" };
  if (!kinds.includes(kind)) return { status: "kind_mismatch" };
  const res = await query<TokenRow>(
    `SELECT t.token_hash, t.user_id, t.kind, t.device_id, t.created_at, t.expires_at, t.revoked_at,
            d.revoked_at AS device_revoked_at, u.status AS user_status
       FROM auth_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN devices d ON d.id = t.device_id
      WHERE t.token_hash = $1`,
    [tokenHash(raw)],
  );
  if (res === null) return { status: "unavailable" }; // БД легла — транзиент, не «токена нет» (иначе разлогин и шторм)
  const row = res.rows[0];
  if (!row) return { status: "not_found" };
  if (row.kind !== kind) return { status: "kind_mismatch" }; // префикс говорит одно, БД — другое: порча/подделка
  const now = opts?.now ?? new Date();
  const expiresAt = toDate(row.expires_at);
  const token: TokenInfo = {
    userId: row.user_id, kind, deviceId: row.device_id, hash: row.token_hash,
    createdAt: toDate(row.created_at) ?? now, expiresAt, userStatus: row.user_status,
  };
  if (row.revoked_at) return { status: "revoked", token };
  if (row.device_revoked_at) return { status: "device_revoked", token };
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return { status: "expired", token };
  if (row.user_status !== "active") return { status: "user_inactive", token };
  return { status: "ok", token };
}

/** Бамп last_seen_at (audit / idle-revoke). Best-effort, результат не нужен. */
export function touchToken(hash: string, now = new Date()): Promise<unknown> {
  return query("UPDATE auth_tokens SET last_seen_at = $2 WHERE token_hash = $1", [hash, ts(now)]);
}

/** null на любой отказ; на успехе бампает last_seen_at fire-and-forget. */
export async function verifyToken(raw: string, kinds: readonly TokenKind[], opts?: { now?: Date }): Promise<TokenInfo | null> {
  const r = await inspectToken(raw, kinds, opts);
  if (r.status !== "ok" || !r.token) return null;
  void touchToken(r.token.hash, opts?.now);
  return r.token;
}
