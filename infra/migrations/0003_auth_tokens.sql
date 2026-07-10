-- =============================================================================
-- §13 / Фаза 6B (B2) — миграция 0003_auth_tokens
-- =============================================================================
-- Шов ВЕРИФИКАЦИИ bearer-токена. ДРЕМЛЕТ на loopback (JARVIS_AUTH_STRICT=0, дефолт):
-- на штатном десктоп-пути НЕ читается и пишется только best-effort (audit last_seen).
-- На 127.0.0.1 Hello.token — это КЛЮЧ ПАРТИЦИИ данных, НЕ аутентификация: любой
-- локальный процесс под тем же пользователем ОС прочитает файл идентичности и
-- переиграет токен, поэтому секрет/HMAC здесь были бы театром (см. gateway/identity.ts).
-- Таблица становится нагруженной ТОЛЬКО для LAN-/hosted-режима (JARVIS_AUTH_STRICT=1).
--
-- Авто-подхват: infra/migrate.mjs (sort() + журнал _migrations). Применять вручную
-- (pnpm db:migrate) — авто-миграции на boot ещё нет (план A5). Все типы/клаузы
-- PGlite-совместимы (TEXT/UUID/TIMESTAMPTZ, ON CONFLICT, gen_random_uuid), стиль 1:1
-- с 0001_init.sql. КАЖДОЕ выражение идемпотентно (IF NOT EXISTS): PGlite-путь в
-- migrate.mjs применяет файл db.exec БЕЗ обёртки транзакции — одиночно-безопасные
-- statements исключают «полу-применение».
-- =============================================================================

CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash   TEXT        PRIMARY KEY,                          -- sha256(token) hex; СЫРОЙ токен НЕ храним
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label        TEXT,                                             -- 'desktop-install' / имя устройства (будущий мульти-девайс UI)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,                                      -- best-effort бамп на успешном handshake (audit / idle-revoke)
    expires_at   TIMESTAMPTZ                                       -- NULL = бессрочно (десктоп-дефолт); ставится для hosted/short-lived
);
COMMENT ON TABLE auth_tokens IS 'Фаза 6B B2: ШОВ верификации bearer-токена. Дремлет на loopback (только ключ партиции); реален лишь при JARVIS_AUTH_STRICT/hosted. token_hash=sha256(token), сырой токен не хранится.';
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
-- token_hash — PK → горячий lookup (SELECT user_id WHERE token_hash=$1) уже индексирован; отдельный UNIQUE не нужен.
-- НЕ сидим строку DEV_USER здесь: непрерывность dev-пути обеспечивает dev-фолбэк резолвера
-- (resolveUserId), который работает при НУЛЕ строк в auth_tokens.
