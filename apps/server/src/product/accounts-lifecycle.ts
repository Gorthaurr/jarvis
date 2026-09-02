/**
 * Жизненный цикл аккаунта (152-ФЗ/GDPR, план §5.1): удаление = tombstone СРАЗУ (status=deleted, email_hash
 * заменён производной — адрес по таблице не восстановить, а повторный триал на тот же email не проходит,
 * пока запись жива) + отзыв всех токенов + отложенный purge (DELETE users; каскады схемы сносят всё
 * per-user). Экспорт — то, что пользователь вправе получить о себе; хеши токенов НЕ выдаём.
 *
 * ⚠️ Схема фиксирована: deletion_requests.user_id → users ON DELETE CASCADE, поэтому done_at после purge
 * ставить НЕКУДА — строка уходит вместе с пользователем. purgeDue отдаёт число реально удалённых; не
 * удалённые (DELETE не прошёл) остаются с done_at IS NULL и попадут в следующий проход — честнее, чем
 * отметка «сделано» до факта.
 */
import { query } from "../db/pool.js";
import { sha256hex } from "../db/users.js";
import { type Account, getAccount } from "./accounts.js";
import { type DeviceInfo, listDevices } from "./devices.js";
import { toDate, ts } from "./rows.js";
import { revokeAllForUser } from "./tokens-lifecycle.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_PREFIX = "deleted:";

/** 'deleted:' + sha256(старый email_hash). В users пишется с суффиксом ':<userId>' — partial UNIQUE требует уникальности. */
export function emailTombstone(emailHash: string): string {
  return TOMBSTONE_PREFIX + sha256hex(emailHash);
}

/** Есть ли удалённый (ещё не purge'нутый) аккаунт с этим email — повторный триал на тот же адрес не даём. */
export async function hasDeletedTombstone(emailHash: string): Promise<boolean> {
  const res = await query<{ id: string }>("SELECT id FROM users WHERE email_hash LIKE $1 LIMIT 1", [`${emailTombstone(emailHash)}:%`]);
  return (res?.rows.length ?? 0) > 0;
}

export type DeletionResult =
  | { ok: true; purgeAfter: Date; tokensRevoked: number; alreadyRequested: boolean }
  | { ok: false; reason: "not_found" | "unavailable" };

/** Заявка на удаление: tombstone сразу, отзыв токенов, purge через purgeAfterDays (деф 30). Идемпотентна. */
export async function requestDeletion(userId: string, opts?: { purgeAfterDays?: number; now?: Date }): Promise<DeletionResult> {
  const now = opts?.now ?? new Date();
  const acc = await getAccount(userId);
  if (!acc) return { ok: false, reason: "not_found" };
  if (acc.status === "deleted") {
    const prev = await query<{ purge_after: unknown }>("SELECT purge_after FROM deletion_requests WHERE user_id = $1", [userId]);
    const purgeAfter = toDate(prev?.rows[0]?.purge_after);
    if (purgeAfter) return { ok: true, purgeAfter, tokensRevoked: 0, alreadyRequested: true };
    // deleted без заявки (setStatus вручную) — доводим до полного удаления ниже
  }
  const purgeAfter = new Date(now.getTime() + (opts?.purgeAfterDays ?? 30) * DAY_MS);
  const tomb = acc.emailHash && !acc.emailHash.startsWith(TOMBSTONE_PREFIX)
    ? `${emailTombstone(acc.emailHash)}:${userId}`
    : acc.emailHash;
  const upd = await query<{ id: string }>(
    "UPDATE users SET status = 'deleted', deleted_at = COALESCE(deleted_at, $2), email_hash = $3, email_enc = NULL WHERE id = $1 RETURNING id",
    [userId, ts(now), tomb],
  );
  if (!upd?.rows.length) return { ok: false, reason: "unavailable" };
  const req = await query<{ purge_after: unknown }>(
    `INSERT INTO deletion_requests (user_id, requested_at, purge_after) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING purge_after`,
    [userId, ts(now), ts(purgeAfter)],
  );
  if (!req?.rows.length) return { ok: false, reason: "unavailable" }; // tombstone уже стоит; повтор доведёт заявку
  const tokensRevoked = await revokeAllForUser(userId, undefined, { now });
  return { ok: true, purgeAfter: toDate(req.rows[0]?.purge_after) ?? purgeAfter, tokensRevoked, alreadyRequested: false };
}

/** Физически удалить пользователей с наступившим purge_after (каскады схемы). Возвращает число удалённых. */
export async function purgeDue(now = new Date()): Promise<number> {
  const res = await query<{ id: string }>(
    `DELETE FROM users WHERE id IN (SELECT user_id FROM deletion_requests WHERE done_at IS NULL AND purge_after <= $1)
     RETURNING id`,
    [ts(now)],
  );
  return res?.rows.length ?? 0;
}

export interface ExportedToken {
  kind: string;
  label: string | null;
  createdAt: Date | null;
  lastSeenAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}
export interface AccountExport {
  account: Account;
  devices: DeviceInfo[];
  tokens: ExportedToken[];
  usage: Record<string, unknown>[];
}

interface TokenExportRow {
  kind: string;
  label: string | null;
  created_at: unknown;
  last_seen_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
}

/** Экспорт данных аккаунта (GET /v1/me/export). Токены — только метаданные, без хешей. */
export async function exportAccount(userId: string): Promise<AccountExport | null> {
  const account = await getAccount(userId);
  if (!account) return null;
  const tokens = await query<TokenExportRow>(
    "SELECT kind, label, created_at, last_seen_at, expires_at, revoked_at FROM auth_tokens WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  const usage = await query<Record<string, unknown>>("SELECT * FROM usage_quota WHERE user_id = $1 ORDER BY period", [userId]);
  return {
    account,
    devices: await listDevices(userId),
    tokens: (tokens?.rows ?? []).map((t) => ({
      kind: t.kind, label: t.label, createdAt: toDate(t.created_at), lastSeenAt: toDate(t.last_seen_at),
      expiresAt: toDate(t.expires_at), revokedAt: toDate(t.revoked_at),
    })),
    usage: usage?.rows ?? [],
  };
}
