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
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Лёгкая загрузка .env из корня репо (без зависимости от dotenv) — чтобы
// `pnpm db:migrate` подхватывал DATABASE_URL так же, как сервер через dotenv.
try {
    const envPath = resolve(__dirname, '..', '.env');
    if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
        }
    }
} catch {
    /* нет .env — используем дефолты */
}

// ---------------------------------------------------------------------------
// Конфигурация
// ---------------------------------------------------------------------------

const DATABASE_URL =
    process.env['DATABASE_URL'] ??
    'postgres://jarvis:jarvis@localhost:5432/jarvis';

const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

// ПРОДУКТОВЫЙ КАРКАС (2026-09-02): миграции 01xx лежат ОТДЕЛЬНО (migrations-product/) и применяются
// только по явной просьбе — `--product` или JARVIS_PRODUCT_MODE=1. Дефолтный `pnpm db:migrate` их не
// трогает: при мастер-флаге 0 боевая БД владельца не меняется (правило «0 = сегодняшнее поведение»).
const PRODUCT_MIGRATIONS =
    process.argv.includes('--product') ||
    /^(1|true|yes|on)$/i.test((process.env['JARVIS_PRODUCT_MODE'] ?? '').trim());
const PRODUCT_MIGRATIONS_DIR = resolve(__dirname, 'migrations-product');

/** Все файлы миграций в порядке применения: базовые 00xx, затем продуктовые 01xx (если включены). */
async function listMigrationFiles() {
    const dirs = [MIGRATIONS_DIR, ...(PRODUCT_MIGRATIONS ? [PRODUCT_MIGRATIONS_DIR] : [])];
    const out = [];
    for (const dir of dirs) {
        let entries;
        try {
            entries = await readdir(dir);
        } catch (err) {
            console.error(`[migrate] Не удалось прочитать директорию миграций ${dir}: ${err.message}`);
            process.exit(1);
        }
        for (const f of entries.filter((f) => f.endsWith('.sql')).sort()) out.push({ name: f, path: join(dir, f) });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Ленивая загрузка драйвера 'pg' (нужен только для нативного/удалённого Postgres;
// для встроенного PGlite — не требуется).
// ---------------------------------------------------------------------------

async function loadPgPool() {
    let pg;
    try {
        pg = await import('pg');
    } catch {
        console.error(
            '\n[migrate] Ошибка: пакет "pg" не найден.\n' +
            'Установите его командой:\n' +
            '  pnpm add -Dw pg\n'
        );
        process.exit(1);
    }
    const { default: pgModule } = pg;
    return pgModule?.Pool ?? pg.Pool;
}

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

    // Встроенный PGlite (локальный dev без установки Postgres).
    if (DATABASE_URL === 'pglite' || DATABASE_URL.startsWith('pglite:')) {
        const dataDir = DATABASE_URL.replace(/^pglite:(\/\/)?/, '') || `${process.cwd()}/infra/pgdata`;
        console.log(`[migrate] Бэкенд: встроенный PGlite (${dataDir})`);
        await migratePglite(dataDir);
        return;
    }

    const Pool = await loadPgPool();
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

        // Все .sql файлы (базовые + продуктовые при --product), в порядке имени внутри каталога
        const files = await listMigrationFiles();
        if (PRODUCT_MIGRATIONS) console.log(`[migrate] + продуктовые миграции: ${PRODUCT_MIGRATIONS_DIR}`);

        if (files.length === 0) {
            console.log('[migrate] Миграций не найдено.');
            return;
        }

        let applied_count = 0;
        let skipped_count = 0;

        for (const { name: file, path: filePath } of files) {
            if (appliedSet.has(file)) {
                console.log(`[migrate] Пропуск (уже применена): ${file}`);
                skipped_count++;
                continue;
            }

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
// Встроенный PGlite — миграции для локального dev без установки Postgres
// ---------------------------------------------------------------------------

async function migratePglite(dataDir) {
    let PGlite, vector;
    try {
        ({ PGlite } = await import('@electric-sql/pglite'));
        ({ vector } = await import('@electric-sql/pglite/vector'));
    } catch {
        console.error('\n[migrate] Ошибка: пакет "@electric-sql/pglite" не найден. pnpm install');
        process.exit(1);
    }

    const db = new PGlite({ dataDir, extensions: { vector } });
    await db.waitReady;
    await db.exec(ENSURE_TABLE_SQL);

    const { rows: applied } = await db.query('SELECT name FROM _migrations ORDER BY name');
    const appliedSet = new Set(applied.map((r) => r.name));

    const files = await listMigrationFiles();
    if (PRODUCT_MIGRATIONS) console.log(`[migrate] + продуктовые миграции: ${PRODUCT_MIGRATIONS_DIR}`);

    let applied_count = 0;
    let skipped_count = 0;
    for (const { name: file, path: filePath } of files) {
        if (appliedSet.has(file)) {
            console.log(`[migrate] Пропуск (уже применена): ${file}`);
            skipped_count++;
            continue;
        }
        const sql = await readFile(filePath, 'utf-8');
        console.log(`[migrate] Применяем (PGlite): ${file} ...`);
        const t0 = Date.now();

        // Каждая миграция — в отдельной транзакции для атомарности (зеркалим нативную ветку)
        await db.exec('BEGIN');
        try {
            await db.exec(sql);
            await db.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
            await db.exec('COMMIT');
            console.log(`[migrate] ✓ ${file} (${Date.now() - t0}ms)`);
            applied_count++;
        } catch (err) {
            await db.exec('ROLLBACK');
            console.error(`[migrate] ✗ Ошибка в ${file}:\n  ${err.message}`);
            await db.close();
            process.exit(1);
        }
    }
    console.log(
        `\n[migrate] Готово: применено ${applied_count}, пропущено ${skipped_count} из ${files.length} миграций.`
    );
    await db.close();
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
