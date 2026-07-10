-- =============================================================================
-- §13 Схема базы данных Jarvis — миграция 0001_init
-- =============================================================================
-- Источник истины: JARVIS_SPEC.md §13. Для таблиц, которые УЖЕ читает/пишет
-- серверный код (episodic_memory, skills, usage_quota, action_log), имена
-- колонок выверены 1:1 с реальными SQL-запросами (memory/episodic.ts,
-- memory/skills.ts, billing/index.ts, db/action-log.ts) — иначе INSERT/SELECT
-- падают на несуществующих колонках. Прочие таблицы — по §13 «на вырост»
-- (intents=умные напоминания, contacts.aliases, *.idempotency_key и т.д.).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- users — профиль пользователя (§13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT        UNIQUE,
    name           TEXT,
    display_name   TEXT,
    locale         TEXT        NOT NULL DEFAULT 'ru',
    timezone       TEXT        NOT NULL DEFAULT 'Europe/Moscow',
    -- persona_config: стиль, голос, do-not-disturb, пороги доверия (§11, §13)
    persona_config JSONB       NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE users IS '§13 Профиль; persona_config — единая точка настройки персоны';

-- =============================================================================
-- user_credentials — серверные креды интеграций, зашифрованные (§13)
-- Сессии userbot VK/TG живут НА КЛИЕНТЕ (§12) и сюда не попадают.
-- Мастер-ключ шифрования — из secret-менеджера сервера, не в БД.
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_credentials (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service        TEXT        NOT NULL,            -- 'maps' | 'deepgram' | ...
    kind           TEXT        NOT NULL,            -- 'oauth' | 'token'
    encrypted_blob BYTEA       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);

-- =============================================================================
-- sessions — сессии WS-соединений (§13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,
    summary     TEXT,                              -- сжатая сводка (compaction)
    tokens_in   BIGINT      NOT NULL DEFAULT 0,
    tokens_out  BIGINT      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- =============================================================================
-- messages — лог диалога (§13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT        NOT NULL,              -- 'user' | 'assistant' | 'tool'
    content     JSONB       NOT NULL,
    tier_used   TEXT,                              -- 'tier0'|'haiku'|'sonnet'|'fable'
    tokens_in   INT         NOT NULL DEFAULT 0,
    tokens_out  INT         NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, created_at DESC);

-- =============================================================================
-- episodic_memory — эпизодическая память (§8, §13)
-- ВЫВЕРЕНО ПО КОДУ memory/episodic.ts: kind, text, salience, stale, embedding.
-- =============================================================================
CREATE TABLE IF NOT EXISTS episodic_memory (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind           TEXT        NOT NULL,           -- 'preference' | 'fact' | 'event'
    text           TEXT        NOT NULL,
    -- embedding: 1536d (text-embedding-3-small, §1); смена модели → пересчёт.
    embedding      VECTOR(1536),
    salience       REAL        NOT NULL DEFAULT 0.5,
    source_session UUID        REFERENCES sessions(id) ON DELETE SET NULL,
    stale          BOOLEAN     NOT NULL DEFAULT FALSE,
    metadata       JSONB       NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at   TIMESTAMPTZ
);
COMMENT ON TABLE episodic_memory IS '§8 Эпизодическая память; колонки выверены по memory/episodic.ts';
-- HNSW (не IVFFlat): строится инкрементально, без обучения на пустой таблице (§13).
CREATE INDEX IF NOT EXISTS idx_episodic_embedding_hnsw
    ON episodic_memory USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_episodic_user ON episodic_memory(user_id, created_at DESC);

-- =============================================================================
-- skills — процедурная память / SKILL.md (§8, §13)
-- ВЫВЕРЕНО ПО КОДУ memory/skills.ts:
--   • id — ТЕКСТОВЫЙ слаг из фронтматтера (напр. 'open-notion'), не UUID;
--   • content_md — КАНОНИЧЕСКИЙ источник; steps — derived-парс;
--   • saveSkill использует ON CONFLICT (id, user_id) → нужен PK/UNIQUE (user_id, id).
-- =============================================================================
CREATE TABLE IF NOT EXISTS skills (
    id            TEXT        NOT NULL,            -- слаг навыка из SKILL.md
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT,
    description   TEXT,
    triggers      JSONB       NOT NULL DEFAULT '[]',
    tools         JSONB       NOT NULL DEFAULT '[]',
    steps         JSONB       NOT NULL DEFAULT '[]',  -- derived из content_md (§8)
    content_md    TEXT,                               -- КАНОНИЧЕСКИЙ источник (§8)
    surface       TEXT,                               -- 'vk-desktop' | 'youtube-web' | ...
    grounding     TEXT        NOT NULL DEFAULT 'a11y', -- 'a11y'|'vision'|'hybrid'
    version       INT         NOT NULL DEFAULT 1,
    success_count INT         NOT NULL DEFAULT 0,
    fail_count    INT         NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)                         -- покрывает ON CONFLICT (id, user_id)
);
COMMENT ON TABLE skills IS '§8 Навыки; content_md канонический, steps derived; id — текстовый слаг';
CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);

-- =============================================================================
-- places — места пользователя для геоконтекста (§9, §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS places (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label             TEXT        NOT NULL,        -- 'home' | 'gym' | 'work'
    lat               DOUBLE PRECISION,
    lng               DOUBLE PRECISION,
    address           TEXT,
    geofence_radius_m INT         NOT NULL DEFAULT 150,
    UNIQUE (user_id, label)
);
CREATE INDEX IF NOT EXISTS idx_places_user ON places(user_id);

-- =============================================================================
-- habits — выученные паттерны (§9, §13)
-- scheduler.learnedPrepMs читает data.minutes (pattern_type='prep_time').
-- =============================================================================
CREATE TABLE IF NOT EXISTS habits (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern_type TEXT        NOT NULL,             -- 'prep_time'|'recurring_event'|'order'
    description  TEXT,
    data         JSONB       NOT NULL DEFAULT '{}', -- напр. {minutes: 10}
    confidence   REAL        NOT NULL DEFAULT 0.5,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);

-- =============================================================================
-- intents — УМНЫЕ НАПОМИНАНИЯ: интент с дедлайном/местом (§9, §13)
-- computed_trigger_ts пересчитывается: deadline − ETA − prep − buffer.
-- (Прежняя миграция держала здесь NLU-лог — это расходилось с §9/scheduler.ts.)
-- =============================================================================
CREATE TABLE IF NOT EXISTS intents (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_text           TEXT        NOT NULL,      -- 'быть в зале'
    place_id            UUID        REFERENCES places(id) ON DELETE SET NULL,
    deadline_ts         TIMESTAMPTZ NOT NULL,
    prep_minutes        INT         NOT NULL DEFAULT 0,  -- из habits, выученное
    travel_mode         TEXT        NOT NULL DEFAULT 'walking', -- walking|driving|transit
    buffer_min          INT         NOT NULL DEFAULT 5,
    computed_trigger_ts TIMESTAMPTZ,               -- результат пересчёта
    status              TEXT        NOT NULL DEFAULT 'pending', -- pending|notified|done|cancelled
    last_recomputed_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_intents_pending
    ON intents(user_id, computed_trigger_ts) WHERE status = 'pending';

-- =============================================================================
-- proactive_events — журнал проактивных срабатываний (§9, §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS proactive_events (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger_type   TEXT        NOT NULL,           -- 'time'|'context'|'external'
    payload        JSONB       NOT NULL DEFAULT '{}',
    salience_score REAL,
    suppressed     BOOLEAN     NOT NULL DEFAULT FALSE, -- зарубил salience/DND
    fired_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_proactive_user ON proactive_events(user_id, fired_at DESC);

-- =============================================================================
-- contacts — адресная книга с алиасами для дизамбигуации (§13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS contacts (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name        TEXT        NOT NULL,
    aliases             JSONB       NOT NULL DEFAULT '[]', -- ["Маша","маша из зала"]
    channels            JSONB       NOT NULL DEFAULT '{}', -- {"telegram":"...","vk":"..."}
    last_interaction_at TIMESTAMPTZ,
    source              TEXT        NOT NULL DEFAULT 'observed', -- observed|imported|manual
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, display_name)
);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);

-- =============================================================================
-- devices — presence-роутинг уведомлений и пуш-токены (§9, §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS devices (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT        NOT NULL,             -- 'desktop'|'mobile'
    push_token   TEXT,
    app_version  TEXT,
    last_seen_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- =============================================================================
-- tasks — долгие задачи: статус/прогресс/отмена/наррация (§20, §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tasks (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id     UUID        REFERENCES sessions(id) ON DELETE SET NULL,
    goal_text      TEXT        NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'queued', -- queued|running|paused|waiting_confirm|done|failed|cancelled
    skill_id       TEXT,                           -- слаг навыка (skills.id), без FK (составной ключ)
    steps_total    INT,
    steps_done     INT         NOT NULL DEFAULT 0,
    result_summary TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_active
    ON tasks(status) WHERE status NOT IN ('done', 'cancelled', 'failed');

-- =============================================================================
-- outbound_messages — исходящие от лица юзера, с гардами (§14, §13)
-- idempotency_key UNIQUE: retry-цикл не отправляет дубль (§14).
-- =============================================================================
CREATE TABLE IF NOT EXISTS outbound_messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel         TEXT        NOT NULL,          -- 'vk'|'telegram'
    contact_id      UUID        REFERENCES contacts(id) ON DELETE SET NULL,
    recipient       TEXT        NOT NULL,          -- резолвнутый адрес в канале
    body            TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending', -- pending|confirmed|sent|blocked
    cadence_ok      BOOLEAN     NOT NULL DEFAULT FALSE, -- прошёл гард кадэнса
    idempotency_key TEXT        UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_pending
    ON outbound_messages(user_id, created_at) WHERE status = 'pending';

-- =============================================================================
-- orders — заказы с гардами (§14, §13)
-- §0 принцип 5: карточные/платёжные данные НЕ хранятся — только аудит.
-- idempotency_key UNIQUE: retry не оформляет три заказа (§14).
-- =============================================================================
CREATE TABLE IF NOT EXISTS orders (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vendor            TEXT        NOT NULL,
    items             JSONB       NOT NULL DEFAULT '[]', -- {name,qty,price} без карточных данных
    total             NUMERIC(12, 2),
    status            TEXT        NOT NULL DEFAULT 'pending', -- pending|confirmed|placed|blocked
    idempotency_key   TEXT        UNIQUE,
    external_order_id TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON COLUMN orders.items IS '§0-p5: только sku/qty/price для аудита, без карточных данных';
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);

-- =============================================================================
-- usage_quota — квоты и учёт трат (§14, §13)
-- PK(user_id, period): одна строка на (юзер × месяц). period = 'YYYY-MM'.
-- ВЫВЕРЕНО ПО КОДУ billing/index.ts: upsert tokens_used / cost_estimate.
-- =============================================================================
CREATE TABLE IF NOT EXISTS usage_quota (
    user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period          TEXT          NOT NULL,        -- 'YYYY-MM'
    tokens_used     BIGINT        NOT NULL DEFAULT 0,
    cost_estimate   NUMERIC(12, 2) NOT NULL DEFAULT 0,
    spend_cap       NUMERIC(12, 2),
    kill_switch     BOOLEAN       NOT NULL DEFAULT FALSE,
    tokens_limit    BIGINT        NOT NULL DEFAULT 1000000,
    actions_used    INT           NOT NULL DEFAULT 0,
    actions_limit   INT           NOT NULL DEFAULT 10000,
    tts_chars_used  INT           NOT NULL DEFAULT 0,
    tts_chars_limit INT           NOT NULL DEFAULT 500000,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, period)
);

-- =============================================================================
-- action_log — аудит всех ActionCommand/Result (§8, §13)
-- ВЫВЕРЕНО ПО КОДУ db/action-log.ts: kind, command, error_message, at.
-- session_id/command_id — TEXT без FK: лог best-effort, сессия может быть не в БД.
-- =============================================================================
CREATE TABLE IF NOT EXISTS action_log (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        REFERENCES users(id) ON DELETE CASCADE, -- nullable (best-effort)
    session_id    TEXT,                            -- best-effort, без FK
    task_id       UUID        REFERENCES tasks(id) ON DELETE SET NULL,
    command_id    TEXT,
    kind          TEXT        NOT NULL,            -- 'input.click' | 'skill.execute' | ...
    command       JSONB       NOT NULL DEFAULT '{}',
    ok            BOOLEAN,
    error_code    TEXT,
    error_message TEXT,
    duration_ms   INT,
    skill_id      TEXT,
    step_index    INT,
    at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE action_log IS '§8 Аудит действий; колонки выверены по db/action-log.ts';
CREATE INDEX IF NOT EXISTS idx_action_log_user ON action_log(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_action_log_command ON action_log(command_id) WHERE command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log(session_id);

-- =============================================================================
-- Триггер: автообновление updated_at
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DO $$ DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users', 'skills', 'tasks', 'orders', 'usage_quota'
    ] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I;
             CREATE TRIGGER trg_%s_updated_at
             BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION update_updated_at();',
            t, t, t, t
        );
    END LOOP;
END $$;
