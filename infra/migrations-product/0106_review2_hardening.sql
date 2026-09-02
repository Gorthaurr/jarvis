-- =============================================================================
-- ПРОДУКТОВЫЙ КАРКАС (2026-09-02, контроль-ревью 2): идемпотентность выдачи, атомарность ротации, триал раз навсегда.
-- (1) subscriptions.last_invoice_id — какой инвойс последним продлил/создал подписку: повтор вебхука после сбоя
--     между выдачей и записью платежа больше не продлевает второй раз (сверка по инвойсу, не по статусу).
-- (2) partial UNIQUE по rotated_from — два одновременных hello старым device-токеном минтили ДВУХ наследников;
--     теперь второй INSERT отбивается БД, ротация честно отдаёт null (гард в SELECT не был атомарным).
-- (3) trial_claims — заявка на триал по email_hash без FK на users: purge удалённого аккаунта (30 дн) уносил
--     tombstone, и тот же адрес получал триал снова.
-- =============================================================================
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_invoice_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_rotated_from_live
    ON auth_tokens(rotated_from) WHERE rotated_from IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS trial_claims (
    email_hash  TEXT        PRIMARY KEY,
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
