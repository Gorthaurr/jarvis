-- =============================================================================
-- §13 Dev-сид: минимальные данные для локальной разработки
-- Идемпотентный — безопасно запускать повторно (ON CONFLICT DO NOTHING).
-- НЕ использовать в production.
-- =============================================================================

-- Один тестовый пользователь с базовой конфигурацией персоны
INSERT INTO users (id, email, display_name, persona_config)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'dev@jarvis.local',
    'Dev User',
    jsonb_build_object(
        'voice',    'alloy',         -- голос TTS (§4)
        'language', 'ru',            -- предпочтительный язык ответов
        'style',    'concise',       -- стиль: concise | detailed | friendly
        'timezone', 'Europe/Moscow'  -- часовой пояс для проактивных событий (§9)
    )
)
ON CONFLICT (id) DO NOTHING;

-- Места: дом и зал — стандартные геозоны для проактивного контекста (§10)
INSERT INTO places (id, user_id, label, address, lat, lon, radius_m)
VALUES
    (
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000001',
        'home',
        'Москва, ул. Примерная, 1',
        55.7558,
        37.6173,
        150  -- радиус геозоны дома (м)
    ),
    (
        '00000000-0000-0000-0000-000000000011',
        '00000000-0000-0000-0000-000000000001',
        'gym',
        'Москва, ул. Спортивная, 10',
        55.7600,
        37.6200,
        100
    )
ON CONFLICT (user_id, label) DO NOTHING;

-- Начальная квота для dev-пользователя на текущий период
-- Лимиты завышены для удобства разработки (§14)
INSERT INTO usage_quota (user_id, period, tokens_limit, actions_limit, tts_chars_limit)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    to_char(NOW(), 'YYYY-MM'),
    99999999,  -- без ограничений на токены в dev
    999999,    -- без ограничений на действия в dev
    9999999    -- без ограничений на TTS в dev
)
ON CONFLICT (user_id, period) DO NOTHING;

-- Системный навык-заглушка (пример структуры definition для §6 SkillStep)
INSERT INTO skills (id, user_id, name, version, definition, enabled)
VALUES (
    '00000000-0000-0000-0000-000000000020',
    NULL,   -- системный навык (user_id = NULL)
    'open_browser',
    '1.0.0',
    jsonb_build_object(
        'steps', jsonb_build_array(
            jsonb_build_object(
                'action', 'browser.open',
                'params', jsonb_build_object('url', '{{params.url}}'),
                'timeoutMs', 5000
            )
        )
    ),
    TRUE
)
ON CONFLICT (user_id, name, version) DO NOTHING;
