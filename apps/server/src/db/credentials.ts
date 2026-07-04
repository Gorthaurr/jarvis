/**
 * Per-user ключи интеграций (§13, Фаза 6B / B4) — хранение в user_credentials ШИФРОВАННО at-rest.
 *
 * Ключ хранится как зашифрованный BYTEA (AES-256-GCM, db/crypto.ts). Резолв на использование:
 * per-user ключ (расшифровка) → иначе платформенный дефолт из .env. Так у каждого тенанта свой ключ,
 * а одиночная установка/dev продолжают работать на .env-ключах без всякой настройки.
 *
 * ⚠️ Без мастер-ключа (db/crypto) setCredential ЧЕСТНО НЕ сохраняет (не пишем секрет открытым) —
 * как клиентский safeStorage keysSkipped. Всё null-безопасно (нет БД → no-op).
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { query } from "./pool.js";

const log: Logger = createLogger("db:credentials");

/** Сохранить (зашифровать) ключ сервиса для юзера. false — нет мастер-ключа/БД (НЕ сохранили). */
export async function setCredential(userId: string, service: string, plaintext: string, kind = "token"): Promise<boolean> {
  const value = String(plaintext ?? "").trim();
  if (!userId || !service || !value) return false;
  const blob = encryptSecret(value);
  if (!blob) {
    log.warn("setCredential: нет мастер-ключа — НЕ сохраняю (секрет открытым не пишем)", { service });
    return false;
  }
  const res = await query(
    `insert into user_credentials (user_id, service, kind, encrypted_blob)
     values ($1, $2, $3, $4)
     on conflict (user_id, service) do update
       set encrypted_blob = excluded.encrypted_blob, kind = excluded.kind`,
    [userId, service, kind, blob],
  );
  return res !== null;
}

/** Получить (расшифровать) ключ сервиса юзера. null — нет строки / нет ключа / порча (GCM auth-fail). */
export async function getCredential(userId: string, service: string): Promise<string | null> {
  const res = await query<{ encrypted_blob: Buffer | Uint8Array }>(
    `select encrypted_blob from user_credentials where user_id = $1 and service = $2 limit 1`,
    [userId, service],
  );
  const blob = res?.rows[0]?.encrypted_blob;
  if (!blob) return null;
  return decryptSecret(Buffer.from(blob));
}

/**
 * Резолв ключа сервиса для использования: per-user (user_credentials) → платформенный .env-дефолт.
 * undefined — нет нигде. Это шов для hosted-режима; провайдеры одиночной установки берут .env напрямую.
 */
export async function resolveUserKey(userId: string, service: string, envFallback?: string): Promise<string | undefined> {
  const own = await getCredential(userId, service);
  if (own) return own;
  const fb = (envFallback ?? "").trim();
  return fb || undefined;
}

/** Список сервисов, для которых у юзера сохранён ключ (без значений) — для UI «какие ключи заданы». */
export async function listCredentialServices(userId: string): Promise<string[]> {
  const res = await query<{ service: string }>(`select service from user_credentials where user_id = $1`, [userId]);
  return res?.rows.map((r) => r.service) ?? [];
}
