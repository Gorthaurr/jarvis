-- =============================================================================
-- §13 Схема базы данных Jarvis
-- Миграция 0001_init — полная инициализация всех таблиц
-- =============================================================================

-- pgvector: расширение для хранения эмбеддингов и HNSW-индексов (§13 §4).
-- HNSW выбран вместо IVFFlat: не требует предварительного обучения (IVFFLAT
-- нужен отдельный VACUUM / ANALYZE перед первым запросом), лучше работает
-- при малых (~10K) объёмах на пользователя и обеспечивает лучший recall
-- при высокой скорости поиска ближайших соседей (ANN).
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- users — основной профиль пользователя
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL UNIQUE,
    display_name  TEXT,
    -- persona_config хранит JSONB с предпочтениями голоса, стиля, языка
    -- (§13: единая точка настройки персоны без лишних столбцов)
    persona_config JSONB      NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE users IS '§13 Профиль пользователя; persona_config — единая точка настройки персоны';
COMMENT ON COLUMN users.persona_config IS 'Предпочтения голоса, стиля ответов, языка — хранится как JSONB для гибкой эволюции схемы';

-- =============================================================================
-- user_credentials — WebAuthn / passwordless хранилище (§8)
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_credentials (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- credential_id — raw bytes из WebAuthn (base64url при передаче, bytea в БД)
    credential_id   BYTEA       NOT NULL UNIQUE,
    public_key      BYTEA       NOT NULL,
    -- counter защищает от replay-атак (WebAuthn spec §6.2.3)
    counter         BIGINT      NOT NULL DEFAULT 0,
    device_type     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);

COMMENT ON TABLE user_credentials IS '§8 WebAuthn/Passkey credentials; counter защищает от replay-атак';
COMMENT ON COLUMN user_credentials.credential_id IS 'raw bytes из WebAuthn Credential ID (UNIQUE — каждый физический ключ уникален)';

CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id
    ON user_credentials(user_id);

-- =============================================================================
-- sessions — сессии WebSocket-соединений (§3 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- started_at / ended_at позволяют восстанавливать контекст при resumed=true (§3)
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at      TIMESTAMPTZ,
    -- device_info: JSON с user-agent, платформой, версией клиента
    device_info   JSONB       NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE sessions IS '§3 WS-сессии; ended_at=NULL означает активную сессию; resumed флаг приходит в ServerHello';

CREATE INDEX IF NOT EXISTS idx_sessions_user_id
    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at
    ON sessions(started_at DESC);

-- =============================================================================
-- messages — лог всех сообщений диалога (§13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- role: 'user' | 'assistant' | 'system'
    role          TEXT        NOT NULL,
    -- content_md — каноническое хранилище в Markdown (§13: единственный истинный
    -- источник текста; HTML/plain производятся на лету при рендере)
    content_md    TEXT        NOT NULL,
    -- envelope_id: UUID из Envelope<T>.id для трассировки (§2)
    envelope_id   UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE messages IS '§13 Лог диалога; content_md — каноническая форма (HTML/plain производятся при рендере)';
COMMENT ON COLUMN messages.content_md IS 'Markdown — единственный истинный источник текста (§13)';

CREATE INDEX IF NOT EXISTS idx_messages_session_id
    ON messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_id
    ON messages(user_id, created_at DESC);

-- =============================================================================
-- episodic_memory — долгосрочная эпизодическая память (§4 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS episodic_memory (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- summary — краткое текстовое резюме эпизода (для отображения / fallback)
    summary       TEXT        NOT NULL,
    -- embedding: 1536-мерный вектор (text-embedding-3-small / ada-002, §4)
    -- Размер 1536 соответствует OpenAI text-embedding-3-small и ada-002.
    -- При смене модели потребуется пересчёт всех эмбеддингов (§4 note).
    embedding     vector(1536),
    -- metadata: источник, теги, идентификаторы связанных сущностей (§4)
    metadata      JSONB       NOT NULL DEFAULT '{}',
    importance    FLOAT4      NOT NULL DEFAULT 0.5, -- 0..1
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE episodic_memory IS '§4 Эпизодическая память; embedding vector(1536) для ANN-поиска';
COMMENT ON COLUMN episodic_memory.embedding IS 'text-embedding-3-small (1536 dim); при смене модели нужен пересчёт';

-- HNSW индекс: §13 выбрал HNSW вместо IVFFlat:
--   • Не требует обучения (CREATE INDEX без предварительного ANALYZE)
--   • Хорошо работает при малых (~10K) per-user объёмах
--   • Recall лучше при ef_search >= 40 (cosine для нормализованных эмбеддингов)
-- На per-user объёмах HNSW опционален (§13 note) — при < 1000 записей
-- последовательный скан быстрее; индекс создаётся заранее для масштаба.
CREATE INDEX IF NOT EXISTS idx_episodic_memory_embedding_hnsw
    ON episodic_memory USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_user_id
    ON episodic_memory(user_id, created_at DESC);

-- =============================================================================
-- skills — каталог навыков (§6 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS skills (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        REFERENCES users(id) ON DELETE CASCADE, -- NULL = системный навык
    name          TEXT        NOT NULL,
    version       TEXT        NOT NULL DEFAULT '1.0.0',
    -- definition: JSON-описание шагов SkillStep[] (§6 ActionCommand)
    definition    JSONB       NOT NULL DEFAULT '{}',
    -- enabled позволяет деактивировать навык без удаления
    enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name, version)
);

COMMENT ON TABLE skills IS '§6 Каталог навыков; user_id=NULL означает системный (глобальный) навык';
COMMENT ON COLUMN skills.definition IS 'SkillStep[] из §6 ActionCommand в JSONB — гибко эволюционирует без миграций схемы';

CREATE INDEX IF NOT EXISTS idx_skills_user_id
    ON skills(user_id) WHERE user_id IS NOT NULL;

-- =============================================================================
-- places — места пользователя для геоконтекста (§10 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS places (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- label: 'home' | 'work' | 'gym' | произвольная метка
    label         TEXT        NOT NULL,
    address       TEXT,
    lat           DOUBLE PRECISION,
    lon           DOUBLE PRECISION,
    -- radius_m: радиус геозоны в метрах (для определения "я дома")
    radius_m      INT         NOT NULL DEFAULT 100,
    metadata      JSONB       NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, label)
);

COMMENT ON TABLE places IS '§10 Геоконтекст; radius_m — геозона для проактивных триггеров';

CREATE INDEX IF NOT EXISTS idx_places_user_id
    ON places(user_id);

-- =============================================================================
-- habits — привычки и расписания пользователя (§10 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS habits (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    -- cron_expr: POSIX-cron для расписания ("0 7 * * 1-5" = будни в 07:00)
    cron_expr     TEXT,
    -- trigger_context: JSONB с условиями (место, время, устройство)
    trigger_context JSONB     NOT NULL DEFAULT '{}',
    action_config JSONB       NOT NULL DEFAULT '{}',
    enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE habits IS '§10 Привычки/расписания; cron_expr — POSIX cron; trigger_context — доп. условия';

CREATE INDEX IF NOT EXISTS idx_habits_user_id
    ON habits(user_id) WHERE enabled = TRUE;

-- =============================================================================
-- intents — распознанные намерения пользователя (§5 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS intents (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    UUID        REFERENCES sessions(id) ON DELETE SET NULL,
    -- intent_type: например 'navigate', 'remind', 'search', 'control'
    intent_type   TEXT        NOT NULL,
    -- raw_text: исходный запрос пользователя
    raw_text      TEXT        NOT NULL,
    -- slots: распознанные сущности (JSONB для гибкости)
    slots         JSONB       NOT NULL DEFAULT '{}',
    -- confidence: уверенность классификатора 0..1
    confidence    FLOAT4,
    -- resolved: true = намерение выполнено / передано в executor
    resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE intents IS '§5 Распознанные намерения; slots — NER-результат в JSONB';

CREATE INDEX IF NOT EXISTS idx_intents_user_id
    ON intents(user_id, created_at DESC);

-- =============================================================================
-- proactive_events — проактивные уведомления (§9 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS proactive_events (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- kind: 'nudge' | 'reminder' | 'alert' | 'suggestion'
    kind          TEXT        NOT NULL DEFAULT 'nudge',
    text          TEXT        NOT NULL,
    reason        TEXT,
    -- expires_at: после этого момента событие не отправляется (§9 FOLLOWUP_WINDOW_MS)
    expires_at    TIMESTAMPTZ NOT NULL,
    -- delivered_at: NULL = ещё не доставлено
    delivered_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE proactive_events IS '§9 Проактивные события; expires_at контролирует FOLLOWUP_WINDOW_MS';

CREATE INDEX IF NOT EXISTS idx_proactive_events_user_pending
    ON proactive_events(user_id, expires_at)
    WHERE delivered_at IS NULL;

-- =============================================================================
-- contacts — адресная книга пользователя (§11 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS contacts (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    -- channels: {"telegram": "@handle", "vk": "id123", "email": "x@y.z"}
    channels      JSONB       NOT NULL DEFAULT '{}',
    -- tags: метки для группировки ['family', 'work']
    tags          TEXT[]      NOT NULL DEFAULT '{}',
    metadata      JSONB       NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE contacts IS '§11 Адресная книга; channels JSONB — мессенджеры без фиксированной схемы';

CREATE INDEX IF NOT EXISTS idx_contacts_user_id
    ON contacts(user_id);

-- =============================================================================
-- devices — устройства пользователя (§12 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS devices (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- device_name: 'Home PC', 'Work Laptop', 'Phone'
    device_name   TEXT        NOT NULL,
    -- platform: 'windows' | 'macos' | 'android' | 'ios' | 'linux'
    platform      TEXT,
    -- push_token: для push-уведомлений (NULL = не зарегистрировано)
    push_token    TEXT,
    -- last_seen_at: обновляется при каждом client.hello (§3)
    last_seen_at  TIMESTAMPTZ,
    -- capabilities: {"screen_capture": true, "audio": true, ...}
    capabilities  JSONB       NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, device_name)
);

COMMENT ON TABLE devices IS '§12 Устройства; capabilities — фичи клиента из ClientState (§3)';

CREATE INDEX IF NOT EXISTS idx_devices_user_id
    ON devices(user_id);

-- =============================================================================
-- tasks — долгосрочные задачи (§7 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tasks (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    UUID        REFERENCES sessions(id) ON DELETE SET NULL,
    -- state: TaskState из §7 ('idle'|'running'|'paused'|'done'|'failed'|'cancelled')
    state         TEXT        NOT NULL DEFAULT 'idle',
    summary       TEXT,
    -- steps_done / steps_total для прогресс-бара (§7 TaskStatus)
    steps_done    INT         NOT NULL DEFAULT 0,
    steps_total   INT,
    -- definition: полное описание задачи / шагов в JSONB
    definition    JSONB       NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);

COMMENT ON TABLE tasks IS '§7 Долгосрочные задачи; state соответствует TaskState из протокола';

CREATE INDEX IF NOT EXISTS idx_tasks_user_id
    ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_state
    ON tasks(state) WHERE state NOT IN ('done', 'cancelled', 'failed');

-- =============================================================================
-- outbound_messages — исходящие сообщения через мессенджеры (§11 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS outbound_messages (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- channel: 'telegram' | 'vk' (§2 MessageChannel)
    channel       TEXT        NOT NULL,
    -- recipient: идентификатор получателя в канале
    recipient     TEXT        NOT NULL,
    body          TEXT        NOT NULL,
    -- status: 'pending' | 'sent' | 'failed'
    status        TEXT        NOT NULL DEFAULT 'pending',
    -- sent_at: время фактической отправки (NULL = ещё не отправлено)
    sent_at       TIMESTAMPTZ,
    error_msg     TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE outbound_messages IS '§11 Очередь исходящих сообщений; status позволяет retry при сбое';

CREATE INDEX IF NOT EXISTS idx_outbound_messages_pending
    ON outbound_messages(user_id, created_at)
    WHERE status = 'pending';

-- =============================================================================
-- orders — заказы (§11 §13)
-- ВАЖНО: платёжные/карточные данные здесь НЕ хранятся (§0 принцип 5).
-- Только метаданные заказа для трассировки — статус, вендор, сумма.
-- =============================================================================
CREATE TABLE IF NOT EXISTS orders (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- vendor: название вендора ('yandex_market', 'wildberries', ...)
    vendor        TEXT        NOT NULL,
    -- external_order_id: ID заказа на стороне вендора (для трекинга)
    external_order_id TEXT,
    -- items: [{name, qty, price_rub}] — без карточных данных
    items         JSONB       NOT NULL DEFAULT '[]',
    -- total_rub: итоговая сумма в рублях (только для аудита, не для платежей)
    total_rub     NUMERIC(12, 2),
    -- status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled'
    status        TEXT        NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE orders IS '§11 Метаданные заказов; §0-p5: платёжные данные НЕ хранятся';
COMMENT ON COLUMN orders.items IS 'Без карточных/платёжных данных — только sku/qty/price для аудита (§0 принцип 5)';

CREATE INDEX IF NOT EXISTS idx_orders_user_id
    ON orders(user_id, created_at DESC);

-- =============================================================================
-- usage_quota — квоты использования ресурсов (§14 §13)
-- PK (user_id, period): составной PK выбран потому что квота существует
-- единственный раз per-user per-period и не требует суррогатного UUID.
-- Это также автоматически создаёт уникальный индекс по (user_id, period).
-- period — строка вида '2024-01' (ISO year-month) для ежемесячных квот.
-- =============================================================================
CREATE TABLE IF NOT EXISTS usage_quota (
    user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- period: 'YYYY-MM' для ежемесячных квот (§14)
    period            TEXT        NOT NULL,
    -- tokens_used / tokens_limit: LLM-токены (§14 Tier)
    tokens_used       BIGINT      NOT NULL DEFAULT 0,
    tokens_limit      BIGINT      NOT NULL DEFAULT 1000000,
    -- actions_used: количество выполненных ActionCommand (§6)
    actions_used      INT         NOT NULL DEFAULT 0,
    actions_limit     INT         NOT NULL DEFAULT 10000,
    -- tts_chars_used: символы TTS (§4 SpeakChunk)
    tts_chars_used    INT         NOT NULL DEFAULT 0,
    tts_chars_limit   INT         NOT NULL DEFAULT 500000,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Составной PK: одна строка на (пользователь × период) — суррогатный
    -- UUID был бы избыточен, т.к. (user_id, period) уже уникален по смыслу
    PRIMARY KEY (user_id, period)
);

COMMENT ON TABLE usage_quota IS '§14 Квоты; PK(user_id,period) — суррогатный UUID избыточен, (user_id,period) уже уникален';
COMMENT ON COLUMN usage_quota.period IS 'YYYY-MM — ежемесячный период; §14 Tier определяет лимиты';

-- =============================================================================
-- action_log — аудит-лог всех выполненных действий (§6 §13)
-- =============================================================================
CREATE TABLE IF NOT EXISTS action_log (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    UUID        REFERENCES sessions(id) ON DELETE SET NULL,
    task_id       UUID        REFERENCES tasks(id) ON DELETE SET NULL,
    -- command_id: UUID из ActionCommandEnvelope для корреляции с ActionResult (§6)
    command_id    UUID,
    -- action_kind: ActionKind из @jarvis/protocol (§6)
    action_kind   TEXT        NOT NULL,
    -- payload: полный ActionCommand в JSONB для детального аудита
    payload       JSONB       NOT NULL DEFAULT '{}',
    -- ok: результат выполнения (true/false = ActionResult.ok)
    ok            BOOLEAN,
    -- duration_ms: время выполнения (§6 ActionResult.durationMs)
    duration_ms   INT,
    error_msg     TEXT,
    -- step_index: индекс шага в skill.execute (§6 SkillStep)
    step_index    INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE action_log IS '§6 Аудит всех ActionCommand; command_id коррелирует с ActionResult.commandId';

-- Индекс (user_id, created_at) — основной паттерн запросов: "последние действия
-- пользователя за период" для аудита и отладки (§13 spec).
CREATE INDEX IF NOT EXISTS idx_action_log_user_created
    ON action_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_action_log_command_id
    ON action_log(command_id) WHERE command_id IS NOT NULL;

-- =============================================================================
-- Триггер: автообновление updated_at для таблиц с этим полем
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
        'users', 'skills', 'habits', 'contacts', 'tasks', 'orders', 'usage_quota'
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
