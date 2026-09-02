-- =============================================================================
-- ПРОДУКТОВЫЙ КАРКАС (2026-09-02), волна «квоты»: ledger per round в микро-долларах + расширение
-- usage_quota лимитами плана и порогами предупреждений.
-- Почему отдельный ledger: usage_quota.cost_estimate NUMERIC(12,2) округляет КАЖДЫЙ раунд до цента
-- ($0.0124 → $0.01, −19%), а тарифное решение и споры требуют точной истории по вызовам.
-- =============================================================================

CREATE TABLE IF NOT EXISTS usage_ledger (
    id                 BIGSERIAL     PRIMARY KEY,
    user_id            UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts                 TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    period             TEXT          NOT NULL,                  -- 'YYYY-MM'
    task_id            TEXT,
    round              INT,
    kind               TEXT          NOT NULL DEFAULT 'llm',    -- llm | stt | tts
    model              TEXT,
    input_tokens       BIGINT        NOT NULL DEFAULT 0,
    output_tokens      BIGINT        NOT NULL DEFAULT 0,
    cache_read_tokens  BIGINT        NOT NULL DEFAULT 0,
    cache_write_tokens BIGINT        NOT NULL DEFAULT 0,
    stt_seconds        NUMERIC(10,2) NOT NULL DEFAULT 0,
    tts_chars          INT           NOT NULL DEFAULT 0,
    cost_micro         BIGINT        NOT NULL DEFAULT 0,        -- µ$ (integer)
    channel            TEXT          NOT NULL DEFAULT 'node',   -- node | proxy | brain
    estimated          BOOLEAN       NOT NULL DEFAULT FALSE,    -- usage не пришёл (обрыв стрима) — оценка вверх
    ok                 BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user_ts ON usage_ledger(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_period ON usage_ledger(period, user_id);

-- usage_quota (0001): оживляем мёртвые колонки и добавляем квоту плана/овердрафт/пороги.
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS llm_quota_micro   BIGINT;
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS cost_micro        BIGINT      NOT NULL DEFAULT 0;
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS overage_allowed   BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS overage_max_micro BIGINT      NOT NULL DEFAULT 0;
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS soft_pct          INT         NOT NULL DEFAULT 80;
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS warned_80_at      TIMESTAMPTZ;
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS warned_100_at     TIMESTAMPTZ;
ALTER TABLE usage_quota ADD COLUMN IF NOT EXISTS quota_source      TEXT;      -- plan | admin | env
