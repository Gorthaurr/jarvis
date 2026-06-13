# Jarvis — Инфраструктура (§13)

## Быстрый старт

### 1. Поднять PostgreSQL

```bash
docker compose -f infra/docker-compose.yml up -d
```

Сервис поднимает PostgreSQL 16 с расширением **pgvector** (образ `pgvector/pgvector:pg16`).

Параметры по умолчанию:
- Host: `localhost:5432`
- User / Password / Database: `jarvis`
- `DATABASE_URL=postgres://jarvis:jarvis@localhost:5432/jarvis`

Проверить готовность:
```bash
docker compose -f infra/docker-compose.yml ps
# postgres должен быть healthy
```

### 2. Применить миграции

```bash
# Через pnpm (из корня монорепо):
pnpm db:migrate

# Или напрямую:
node infra/migrate.mjs

# С кастомным DATABASE_URL:
DATABASE_URL=postgres://user:pass@host:5432/db node infra/migrate.mjs
```

Скрипт применяет все `infra/migrations/*.sql` в лексикографическом порядке.
Уже применённые миграции пропускаются (таблица `_migrations`).

### 3. Dev-сид (опционально)

Миграция `0002_seed_dev.sql` применяется автоматически вместе с остальными.
Она создаёт тестового пользователя `dev@jarvis.local` и базовые места (home/gym).

---

## Структура миграций

```
infra/
├── migrations/
│   ├── 0001_init.sql          # Все таблицы §13 + pgvector + HNSW-индекс
│   └── 0002_seed_dev.sql      # Dev-сид (идемпотентный)
├── docker-compose.yml         # postgres (+ redis/osrm закомментированы)
├── migrate.mjs                # Раннер миграций (ESM, Node.js)
└── README.md
```

---

## pgvector и HNSW

Таблица `episodic_memory` хранит 1536-мерные эмбеддинги (text-embedding-3-small / ada-002)
и использует **HNSW-индекс** (`vector_cosine_ops`):

```sql
CREATE INDEX idx_episodic_memory_embedding_hnsw
    ON episodic_memory USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

**Почему HNSW, а не IVFFlat (§13):**
- Не требует предобучения — `CREATE INDEX` без предварительного `VACUUM/ANALYZE`
- Лучший recall на малых объёмах (~10K записей на пользователя)
- Детерминированный результат без зависимости от числа списков

**Заметка о per-user объёмах (§13):**
При менее ~1000 записей на пользователя последовательный скан (`ORDER BY embedding <=> $1 LIMIT k`)
может быть быстрее индексного поиска. HNSW создаётся заранее для масштабирования.
При необходимости его можно отключить и включать по достижении порога.

---

## Опциональные сервисы

### Redis (§1)

Раскомментировать сервис `redis` в `docker-compose.yml` когда потребуется:
- Pub/Sub для WS fan-out на нескольких серверах (§3)
- Кэш LLM/TTS результатов (§4)
- Очередь `outbound_messages` (§11)

### OSRM

Раскомментировать сервис `osrm` когда нужен расчёт маршрутов для геоконтекста (§10).
Требует предварительной загрузки карты (инструкции в `docker-compose.yml`).

---

## Команды pnpm

Добавьте в `package.json` корня монорепо:

```json
{
  "scripts": {
    "db:up":      "docker compose -f infra/docker-compose.yml up -d",
    "db:down":    "docker compose -f infra/docker-compose.yml down",
    "db:migrate": "node infra/migrate.mjs"
  }
}
```

---

## Требования

- Docker + Docker Compose v2
- Node.js >= 18 (ESM, `import()`)
- `pg` пакет для migrate.mjs: `pnpm add -D pg` (или глобально `npm i -g pg`)
