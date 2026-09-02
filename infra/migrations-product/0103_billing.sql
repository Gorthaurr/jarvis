-- =============================================================================
-- ПРОДУКТОВЫЙ КАРКАС (2026-09-02), волна «оплата»: инвойсы, платежи, идемпотентные вебхуки.
-- §0-p5: карт/платёжных реквизитов здесь НЕТ — только ссылки провайдера (hosted-checkout).
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoices (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id UUID        REFERENCES subscriptions(id) ON DELETE SET NULL,
    plan_id         TEXT        REFERENCES plans(id),
    amount_minor    INT         NOT NULL,
    currency        TEXT        NOT NULL DEFAULT 'RUB',
    status          TEXT        NOT NULL DEFAULT 'pending',   -- draft | pending | paid | failed | refunded | canceled
    period_start    TIMESTAMPTZ,
    period_end      TIMESTAMPTZ,
    provider        TEXT        NOT NULL DEFAULT 'none',
    provider_ref    TEXT,                                     -- id платежа/чекаута у провайдера
    checkout_url    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_provider_ref ON invoices(provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id          UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    provider            TEXT        NOT NULL,
    provider_payment_id TEXT        NOT NULL,
    amount_minor        INT         NOT NULL,
    currency            TEXT        NOT NULL DEFAULT 'RUB',
    status              TEXT        NOT NULL,                  -- succeeded | failed | refunded | canceled
    raw                 JSONB       NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_id ON payments(provider, provider_payment_id);

-- Идемпотентность вебхуков: (provider, event_id) — PK; повтор события → INSERT ON CONFLICT DO NOTHING → no-op.
CREATE TABLE IF NOT EXISTS webhook_events (
    provider     TEXT        NOT NULL,
    event_id     TEXT        NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    outcome      TEXT,
    payload      JSONB       NOT NULL DEFAULT '{}',
    PRIMARY KEY (provider, event_id)
);
