/**
 * Ротация и отзыв токенов (продолжение tokens.ts, вынесено по размеру/SRP).
 *
 * Ротация оставляет старому device-токену хвост ROTATED_TAIL_MS: клиент с двумя сокетами (reconnect
 * посреди ротации) не вылетит на «токен не найден». Если старый и так истекал раньше — срок НЕ продлеваем
 * (ротация не должна давать токену жизни больше, чем у него было). Отзыв ставит revoked_at, сырой токен
 * по-прежнему не хранится. Всё null-безопасно: без БД — null/false/0, не ложный успех.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";
import { ts } from "./rows.js";
import { type IssuedToken, type TokenKind, issueToken } from "./tokens.js";

const log: Logger = createLogger("product:tokens");

/** Хвост жизни старого device-токена после ротации (гонка reconnect). */
/**
 * Хвост старого токена после ротации. Ревью 2026-09-02: 24 ч + повторная ротация на каждом hello давали
 * «россыпь» живых токенов; теперь наследник минтится ОДИН раз (гард в SELECT ниже), а клиент персистит
 * новый токен сразу — часа на переезд достаточно, дольше жить старому незачем.
 */
export const ROTATED_TAIL_MS = 60 * 60 * 1000;

/** Скользящая ротация device-токена: новый наследует user/device/label; старый доживает ≤ ROTATED_TAIL_MS. */
export async function rotateDeviceToken(oldHash: string, ttlMs: number, opts?: { now?: Date }): Promise<IssuedToken | null> {
  const now = opts?.now ?? new Date();
  const res = await query<{ user_id: string; device_id: string | null; label: string | null }>(
    `SELECT t.user_id, t.device_id, t.label FROM auth_tokens t
      WHERE t.token_hash = $1 AND t.kind = 'device' AND t.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM auth_tokens s WHERE s.rotated_from = t.token_hash AND s.revoked_at IS NULL)`,
    [oldHash],
  );
  const old = res?.rows[0];
  if (!old) return null;
  const fresh = await issueToken({
    userId: old.user_id, kind: "device", ttlMs, deviceId: old.device_id ?? undefined,
    label: old.label ?? undefined, rotatedFrom: oldHash, now,
  });
  if (!fresh) return null;
  const tail = ts(new Date(now.getTime() + ROTATED_TAIL_MS));
  const upd = await query<{ token_hash: string }>(
    `UPDATE auth_tokens
        SET expires_at = CASE WHEN expires_at IS NULL OR expires_at > $2::timestamptz THEN $2::timestamptz ELSE expires_at END
      WHERE token_hash = $1 RETURNING token_hash`,
    [oldHash, tail],
  );
  if (!upd?.rows.length) log.warn("ротация: хвост старому токену не выставлен — живёт до прежнего срока", { userId: old.user_id });
  return fresh;
}

/** Отозвать один токен. false — не найден / уже отозван / БД недоступна. */
export async function revokeToken(hash: string, opts?: { now?: Date }): Promise<boolean> {
  const res = await query<{ token_hash: string }>(
    "UPDATE auth_tokens SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING token_hash",
    [hash, ts(opts?.now ?? new Date())],
  );
  return (res?.rows.length ?? 0) > 0;
}

/** Отозвать все живые токены пользователя (kinds пуст/не задан = все виды). Возвращает число отозванных. */
export async function revokeAllForUser(userId: string, kinds?: readonly TokenKind[], opts?: { now?: Date }): Promise<number> {
  const params: unknown[] = [userId, ts(opts?.now ?? new Date())];
  let kindClause = "";
  if (kinds && kinds.length > 0) {
    kindClause = ` AND kind IN (${kinds.map((_, i) => `$${i + 3}`).join(", ")})`;
    params.push(...kinds);
  }
  const res = await query<{ token_hash: string }>(
    `UPDATE auth_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL${kindClause} RETURNING token_hash`,
    params,
  );
  return res?.rows.length ?? 0;
}
