#!/usr/bin/env node
// =============================================================================
// Jarvis — раннер SQL-миграций (§13)
// ESM, без зависимостей кроме 'pg' (динамический импорт с понятной ошибкой).
// Применяет все infra/migrations/*.sql по алфавитному порядку имени,
// каждую — в отдельной транзакции; пропускает уже применённые (идемпотентно).
//
// Использование:
//   node infra/migrate.mjs
//   DATABASE_URL=postgres://... node infra/migrate.mjs
// =============================================================================

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

const DATABASE_URL =
    process.env['DATABASE_URL'] ??
    'postgres://jarvis:jarvis@localhost:5432/jarvis';

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

// ---------------------------------------------------------------------------
// Динамический импорт 'pg' с понятной ошибкой если не установлен
// ---------------------------------------------------------------------------

/** @type {import('pg')} */
let pg;
try {
    pg = await import('pg');
} catch {
    console.error(
        '\n[migrate] Ошибка: пакет "pg" не найден.\n' +
        'Установите его командой:\n' +
        '  pnpm add -D pg\n' +
        '  # или глобально:\n' +
        '  npm install -g pg\n'
    );
    process.exit(1);
}

const { default: pgModule } = pg;
// Поддержка как default-экспорта { Pool }, так и прямого { Pool }
const Pool = pgModule?.Pool ?? pg.Pool;

// ---------------------------------------------------------------------------
// Таблица _migrations — журнал применённых миграций
// ---------------------------------------------------------------------------

const ENSURE_TABLE_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS _migrations (
    name       TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// ---------------------------------------------------------------------------
// Основная логика
// ---------------------------------------------------------------------------

async function main() {
    console.log(`[migrate] DATABASE_URL: ${maskUrl(DATABASE_URL)}`);
    console.log(`[migrate] Директория миграций: ${MIGRATIONS_DIR}`);

    const pool = new Pool({ connectionString: DATABASE_URL });

    // Проверяем соединение
    const client = await pool.connect().catch((err) => {
        console.error(`[migrate] Не удалось подключиться к БД: ${err.message}`);
        console.error('  Убедитесь, что PostgreSQL запущен (docker compose up -d)');
        process.exit(1);
    });

    try {
        // Создаём журнал миграций если его нет
        await client.query(ENSURE_TABLE_SQL);

        // Читаем уже применённые миграции
        const { rows: applied } = await client.query(
            'SELECT name FROM _migrations ORDER BY name'
        );
        const appliedSet = new Set(applied.map((r) => r.name));

        // Читаем все .sql файлы из директории миграций, сортируем по имени
        let files;
        try {
            const entries = await readdir(MIGRATIONS_DIR);
            files = entries
                .filter((f) => f.endsWith('.sql'))
                .sort(); // лексикографический порядок = 0001, 0002, ...
        } catch (err) {
            console.error(`[migrate] Не удалось прочитать директорию миграций: ${err.message}`);
            process.exit(1);
        }

        if (files.length === 0) {
            console.log('[migrate] Миграций не найдено.');
            return;
        }

        let applied_count = 0;
        let skipped_count = 0;

        for (const file of files) {
            if (appliedSet.has(file)) {
                console.log(`[migrate] Пропуск (уже применена): ${file}`);
                skipped_count++;
                continue;
            }

            const filePath = join(MIGRATIONS_DIR, file);
            const sql = await readFile(filePath, 'utf-8');

            console.log(`[migrate] Применяем: ${file} ...`);
            const t0 = Date.now();

            // Каждая миграция — в отдельной транзакции для атомарности
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query(
                    'INSERT INTO _migrations (name) VALUES ($1)',
                    [file]
                );
                await client.query('COMMIT');
                const ms = Date.now() - t0;
                console.log(`[migrate] ✓ ${file} (${ms}ms)`);
                applied_count++;
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`[migrate] ✗ Ошибка в ${file}:`);
                console.error(`  ${err.message}`);
                process.exit(1);
            }
        }

        console.log(
            `\n[migrate] Готово: применено ${applied_count}, пропущено ${skipped_count} из ${files.length} миграций.`
        );
    } finally {
        client.release();
        await pool.end();
    }
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * Скрывает пароль в URL для безопасного логирования.
 * postgres://user:PASSWORD@host/db -> postgres://user:***@host/db
 * @param {string} url
 * @returns {string}
 */
function maskUrl(url) {
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        return u.toString();
    } catch {
        return url.replace(/:([^@/]+)@/, ':***@');
    }
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

main().catch((err) => {
    console.error('[migrate] Неожиданная ошибка:', err);
    process.exit(1);
});
