-- =============================================================================
-- §13 Dev-сид: минимальные данные для локальной разработки
-- Идемпотентный — безопасно запускать повторно (ON CONFLICT DO NOTHING).
-- НЕ использовать в production.
-- =============================================================================

-- Тестовый пользователь
INSERT INTO users (id, email, display_name, persona_config)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'dev@jarvis.local',
    'Dev User',
    jsonb_build_object(
        'voice',    'alloy',
        'language', 'ru',
        'style',    'concise',
        'timezone', 'Europe/Moscow'
    )
)
ON CONFLICT (id) DO NOTHING;

-- Места: дом и зал — геозоны для проактивного контекста (§9)
INSERT INTO places (id, user_id, label, address, lat, lng, geofence_radius_m)
VALUES
    ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
     'home', 'Москва, ул. Примерная, 1', 55.7558, 37.6173, 150),
    ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001',
     'gym',  'Москва, ул. Спортивная, 10', 55.7600, 37.6200, 100)
ON CONFLICT (user_id, label) DO NOTHING;

-- Выученная привычка: время сборов 10 минут (§9, scheduler.learnedPrepMs)
INSERT INTO habits (id, user_id, pattern_type, description, data, confidence)
VALUES (
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000001',
    'prep_time', 'Обычное время сборов', jsonb_build_object('minutes', 10), 0.6
)
ON CONFLICT (id) DO NOTHING;

-- Начальная квота на текущий период (лимиты завышены для dev, §14)
INSERT INTO usage_quota (user_id, period, tokens_limit, actions_limit, tts_chars_limit)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    to_char(NOW(), 'YYYY-MM'),
    99999999, 999999, 9999999
)
ON CONFLICT (user_id, period) DO NOTHING;

-- Пример навыка (§8): канон — content_md, steps — derived-парс.
INSERT INTO skills (id, user_id, name, version, content_md, steps, grounding)
VALUES (
    'open-browser',
    '00000000-0000-0000-0000-000000000001',
    'Открыть браузер',
    1,
    E'---\nid: open-browser\nname: Открыть браузер\nversion: 1\n---\n\n## Шаги\n1. browser.open url="https://example.com"\n',
    jsonb_build_array(
        jsonb_build_object(
            'action', 'browser.open',
            'params', jsonb_build_object('url', 'https://example.com')
        )
    ),
    'a11y'
)
ON CONFLICT (user_id, id) DO NOTHING;
