-- =============================================================================
-- ПРОДУКТОВЫЙ КАРКАС (2026-09-02), волна «подписки»: планы, подписки, гранты кредитов.
-- Модель монетизации — ГИБРИД (docs/PRODUCT_FRAMEWORK_PLAN_2026-09-02.md §4.4): подписка за софт
-- (byo — свой ключ) или с включённой квотой «мозга проекта» (basic/pro), плюс предоплаченные пакеты
-- кредитов (kind='pack'). demo — бесплатный план для друзей на время демки (выдаёт админ).
-- Деньги в минимальных единицах валюты (копейки); квоты и кредиты — в МИКРО-долларах (integer):
-- никакого округления до цента на раунд (дефект usage_quota.cost_estimate NUMERIC(12,2)).
-- Цифры сидов — стартовые, правятся админом; ON CONFLICT DO NOTHING — повторный прогон не перетирает.
-- =============================================================================

CREATE TABLE IF NOT EXISTS plans (
    id                 TEXT        PRIMARY KEY,
    name               TEXT        NOT NULL,
    kind               TEXT        NOT NULL DEFAULT 'subscription',   -- 'subscription' | 'pack'
    price_minor        INT         NOT NULL DEFAULT 0,                -- копейки
    currency           TEXT        NOT NULL DEFAULT 'RUB',
    period             TEXT        NOT NULL DEFAULT 'month',          -- 'month' | 'once'
    llm_quota_micro    BIGINT      NOT NULL DEFAULT 0,                -- квота мозга проекта за период, µ$
    pack_credits_micro BIGINT      NOT NULL DEFAULT 0,                -- kind='pack': кредиты за покупку, µ$
    overage_allowed    BOOLEAN     NOT NULL DEFAULT FALSE,
    overage_max_micro  BIGINT      NOT NULL DEFAULT 0,
    models_allowed     JSONB       NOT NULL DEFAULT '[]',             -- [] = любая модель каталога
    byo_key            BOOLEAN     NOT NULL DEFAULT FALSE,            -- пользователь платит провайдеру сам
    trial_days         INT         NOT NULL DEFAULT 0,
    features           JSONB       NOT NULL DEFAULT '{}',
    active             BOOLEAN     NOT NULL DEFAULT TRUE,
    sort_order         INT         NOT NULL DEFAULT 100,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO plans (id, name, kind, price_minor, currency, period, llm_quota_micro, pack_credits_micro, models_allowed, byo_key, trial_days, sort_order) VALUES
    ('demo',    'Демо (для друзей)', 'subscription',      0, 'RUB', 'month',  3000000,        0, '["claude-sonnet-4-6","claude-sonnet-5"]', FALSE, 0,  10),
    ('trial',   'Пробный',           'subscription',      0, 'RUB', 'month',  2000000,        0, '["claude-sonnet-4-6","claude-sonnet-5"]', FALSE, 7,  20),
    ('byo',     'Свой ключ',         'subscription',  70000, 'RUB', 'month',        0,        0, '[]',                                      TRUE,  0,  30),
    ('basic',   'Базовый',           'subscription', 150000, 'RUB', 'month',  8000000,        0, '["claude-sonnet-4-6","claude-sonnet-5"]', FALSE, 0,  40),
    ('pro',     'Про',               'subscription', 390000, 'RUB', 'month', 25000000,        0, '[]',                                      FALSE, 0,  50),
    ('pack50',  'Пакет 50 задач',    'pack',          90000, 'RUB', 'once',         0,  4370000, '[]',                                      FALSE, 0, 110),
    ('pack100', 'Пакет 100 задач',   'pack',         150000, 'RUB', 'once',         0,  8740000, '[]',                                      FALSE, 0, 120),
    ('pack300', 'Пакет 300 задач',   'pack',         390000, 'RUB', 'once',         0, 26220000, '[]',                                      FALSE, 0, 130)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriptions (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id                  TEXT        NOT NULL REFERENCES plans(id),
    status                   TEXT        NOT NULL,                     -- trialing | active | past_due | canceled | expired
    current_period_start     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end       TIMESTAMPTZ NOT NULL,
    trial_end                TIMESTAMPTZ,
    cancel_at_period_end     BOOLEAN     NOT NULL DEFAULT FALSE,
    grace_until              TIMESTAMPTZ,
    provider                 TEXT        NOT NULL DEFAULT 'none',
    provider_customer_id     TEXT,
    provider_subscription_id TEXT,
    source                   TEXT        NOT NULL DEFAULT 'signup',    -- signup | payment | admin | demo
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Одна живая подписка на пользователя.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_live ON subscriptions(user_id) WHERE status IN ('trialing', 'active', 'past_due');
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, created_at DESC);

-- Гранты кредитов (пакеты, админ, триал, возвраты): не сгорают в конце месяца (expires_at NULL).
CREATE TABLE IF NOT EXISTS credit_grants (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source          TEXT        NOT NULL,                              -- pack | admin | trial | refund
    plan_id         TEXT        REFERENCES plans(id),
    amount_micro    BIGINT      NOT NULL,
    remaining_micro BIGINT      NOT NULL,
    expires_at      TIMESTAMPTZ,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_grants_user ON credit_grants(user_id, created_at);
