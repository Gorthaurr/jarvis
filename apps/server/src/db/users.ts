/**
 * Провижн пользователей и шов верификации токена (§13, Фаза 6B / B2).
 *
 * ГРАНИЦА БЕЗОПАСНОСТИ (честно): на дефолтной конфигурации сервер слушает 127.0.0.1, и
 * Hello.token — это КЛЮЧ ПАРТИЦИИ данных, НЕ аутентификация. На корректном loopback он не
 * защищает НИ ОТ ЧЕГО — и это правильно: любой локальный процесс под тем же пользователем ОС
 * прочитает файл идентичности и переиграет токен. Секрет/HMAC/подпись здесь были бы театром.
 * Реальная граница loopback — это bind-адрес (см. server.ts listen-гард). auth_tokens становится
 * нагруженной только при JARVIS_AUTH_STRICT=1 (LAN/hosted): sha256(token) (СЫРОЙ токен не храним) +
 * expiry + ревокация — корректные примитивы для будущего мульти-юзер сервера.
 *
 * ВСЁ null-безопасно: query() сам отдаёт null при отсутствии/сбое БД (инвариант «сервер работает
 * без БД»). Здесь это значит no-op (логируем и выходим), а не throw — handshake всегда завершается.
 */
import { createHash } from "node:crypto";
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "./pool.js";

const log: Logger = createLogger("db:users");

/** sha256(token) в hex. Forward-совместимый примитив hosted-режима; на loopback токен == userId. */
export function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Лениво создать строку users (INSERT ... ON CONFLICT DO NOTHING). Идемпотентно.
 * ОБЯЗАН пройти ДО любого per-user INSERT в сессии — иначе FK (episodic/skills/tasks/usage) молча
 * падает (query() глотает ошибку → данные не персистятся). Закрывает Hazard 1 в момент выдачи
 * реальных per-install UUID. No-op при отсутствии БД (только in-memory/JSON-фолбэки — им FK не нужен).
 */
export async function ensureUser(userId: string): Promise<void> {
  const res = await query("INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [userId]);
  if (res === null) log.debug("ensureUser: БД недоступна — пропуск (in-memory режим)", { userId });
}

/**
 * Записать/обновить строку auth_tokens (TOFU: при первом успешном handshake запоминаем хеш токена;
 * на повторных — бамп last_seen_at для audit/idle-revoke). Идемпотентно. No-op без БД.
 * НЕ для dev-пути (dev-токен партиционируется фолбэком, токен-строку не пишем).
 */
export async function recordToken(userId: string, tokenHash: string, label = "desktop-install"): Promise<void> {
  const res = await query(
    `INSERT INTO auth_tokens (token_hash, user_id, label, last_seen_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (token_hash) DO UPDATE SET last_seen_at = NOW()`,
    [tokenHash, userId, label],
  );
  if (res === null) log.debug("recordToken: БД недоступна — пропуск", { userId });
}

/**
 * Найти userId по хешу токена (только свежие: expires_at IS NULL или в будущем).
 * null — нет строки ИЛИ БД недоступна (вызывающий в strict-режиме различает их через isDbReady()).
 */
export async function findUserByTokenHash(tokenHash: string): Promise<string | null> {
  const res = await query<{ user_id: string }>(
    `SELECT user_id FROM auth_tokens
     WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [tokenHash],
  );
  return res?.rows[0]?.user_id ?? null;
}
