/**
 * Устройства (установки клиента) продукта: привязка device-токена к install UUID клиента (план §5.1;
 * таблица devices из 0001 до этой волны не имела ни одной записи). Повторная регистрация того же
 * (user, install) — апсерт: снимает revoked_at (вход по коду после отзыва — легитимное возвращение),
 * обновляет имя и last_seen. Отзыв устройства отзывает и ВСЕ его токены — иначе «отозвал ноутбук» было
 * бы пометкой в UI, а токен работал бы дальше.
 */
import { type Logger, createLogger } from "@jarvis/shared";
import { query } from "../db/pool.js";
import { isUuid } from "../gateway/identity.js";
import { toDate, ts } from "./rows.js";

const log: Logger = createLogger("product:devices");

export type DeviceKind = "desktop" | "mobile";

export interface DeviceInfo {
  id: string;
  installId: string | null;
  name: string | null;
  kind: string;
  createdAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

interface DeviceRow {
  id: string;
  install_id: string | null;
  name: string | null;
  kind: string;
  created_at: unknown;
  last_seen_at: unknown;
  revoked_at: unknown;
}

export interface RegisterDeviceInput {
  userId: string;
  installId: string;
  name?: string;
  kind?: DeviceKind;
  now?: Date;
}

/** Зарегистрировать/обновить установку → deviceId. null — installId не UUID или БД не приняла. */
export async function registerDevice(input: RegisterDeviceInput): Promise<string | null> {
  const installId = input.installId.trim().toLowerCase();
  if (!isUuid(installId)) {
    log.warn("registerDevice: installId не UUID — устройство не зарегистрировано", { userId: input.userId });
    return null;
  }
  const res = await query<{ id: string }>(
    `INSERT INTO devices (user_id, install_id, name, kind, last_seen_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, install_id) WHERE install_id IS NOT NULL
     DO UPDATE SET revoked_at = NULL, name = COALESCE(EXCLUDED.name, devices.name), kind = EXCLUDED.kind,
                   last_seen_at = EXCLUDED.last_seen_at
     RETURNING id`,
    [input.userId, installId, input.name ?? null, input.kind ?? "desktop", ts(input.now ?? new Date())],
  );
  return res?.rows[0]?.id ?? null;
}

function mapDevice(r: DeviceRow): DeviceInfo {
  return {
    id: r.id, installId: r.install_id, name: r.name, kind: r.kind,
    createdAt: toDate(r.created_at), lastSeenAt: toDate(r.last_seen_at), revokedAt: toDate(r.revoked_at),
  };
}

/** Все устройства пользователя (включая отозванные — их видно в UI как отозванные). */
export async function listDevices(userId: string): Promise<DeviceInfo[]> {
  const res = await query<DeviceRow>(
    "SELECT id, install_id, name, kind, created_at, last_seen_at, revoked_at FROM devices WHERE user_id = $1 ORDER BY created_at, id",
    [userId],
  );
  return (res?.rows ?? []).map(mapDevice);
}

/** Отозвать устройство И все токены, привязанные к нему. device:false — не найдено / чужое / уже отозвано. */
export async function revokeDevice(
  userId: string,
  deviceId: string,
  opts?: { now?: Date },
): Promise<{ device: boolean; tokensRevoked: number }> {
  const now = ts(opts?.now ?? new Date());
  const dev = await query<{ id: string }>(
    "UPDATE devices SET revoked_at = $3 WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL RETURNING id",
    [userId, deviceId, now],
  );
  const tokens = await query<{ token_hash: string }>(
    "UPDATE auth_tokens SET revoked_at = $3 WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL RETURNING token_hash",
    [userId, deviceId, now],
  );
  return { device: (dev?.rows.length ?? 0) > 0, tokensRevoked: tokens?.rows.length ?? 0 };
}
