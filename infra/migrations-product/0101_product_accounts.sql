-- =============================================================================
-- ПРОДУКТОВЫЙ КАРКАС (2026-09-02), волна «идентичность»: аккаунты, device/access/refresh-токены,
-- одноразовые коды, запросы на удаление.
--
-- ⚠️ Каталог migrations-product/ применяется ТОЛЬКО `node infra/migrate.mjs --product` (или при
-- JARVIS_PRODUCT_MODE=1). Дефолтный `pnpm db:migrate` его НЕ трогает — боевая БД владельца при
-- мастер-флаге 0 не мигрируется и не читается продуктовым кодом. Все выражения идемпотентны и
-- PGlite-совместимы (прецедент 0006: ADD COLUMN IF NOT EXISTS).
-- =============================================================================

-- users: email — только HMAC-хеш (утечка таблицы не даёт словарной атаки по адресам); зашифрованный
-- адрес (AES-GCM через db/crypto) нужен лишь для отправки кодов и включается конфигурацией (1) плана
-- (email-OTP ⇒ ПДн ⇒ РФ-ЦОД). Колонка email (0001) в продукте не пишется.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_enc BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';        -- user | admin
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';    -- active | blocked | deleted
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_hash ON users(email_hash) WHERE email_hash IS NOT NULL;

-- auth_tokens (0003): kind разводит device (узел ↔ облако, WS hello) / access (HTTP /v1) / refresh.
-- Строки B2 без kind остаются device по дефолту. Отзыв — revoked_at (сырой токен по-прежнему не храним).
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'device';
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS device_id UUID;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS rotated_from TEXT;
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_kind ON auth_tokens(user_id, kind);

-- devices (0001, до сих пор без единой записи): привязка device-токена к установке (install UUID клиента).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS install_id UUID;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_install ON devices(user_id, install_id) WHERE install_id IS NOT NULL;

-- Одноразовые коды входа/подтверждения удаления. Код хранится ТОЛЬКО хешем с солью.
CREATE TABLE IF NOT EXISTS auth_challenges (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email_hash  TEXT        NOT NULL,
    purpose     TEXT        NOT NULL,                 -- 'otp' | 'delete'
    code_hash   TEXT        NOT NULL,                 -- sha256(salt || code)
    salt        TEXT        NOT NULL,
    attempts    INT         NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    ip_hash     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_email ON auth_challenges(email_hash, created_at DESC);

-- Отложенное удаление аккаунта (152-ФЗ/GDPR): tombstone сразу, purge — по сроку.
CREATE TABLE IF NOT EXISTS deletion_requests (
    user_id      UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    purge_after  TIMESTAMPTZ NOT NULL,
    done_at      TIMESTAMPTZ
);
