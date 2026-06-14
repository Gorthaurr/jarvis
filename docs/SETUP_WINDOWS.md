# Запуск Jarvis локально (Windows)

Пошаговый гайд «от нуля до работающего сервера». Клиент Electron и C#-сайдкар —
отдельными разделами в конце (им нужны доп. инструменты).

## 0. Предусловия (уже есть на машине)

- **Node.js** ≥ 20 (стоит v22) — `node -v`
- **pnpm** 9 — `pnpm -v`
- **.NET 8 SDK** — НЕ установлен; нужен только для C#-сайдкара (раздел 6).

## 1. Зависимости

```powershell
pnpm install
```

## 2. Переменные окружения

Файл `.env` в корне уже создан (в git не коммитится). Откройте и вставьте ключ:

```ini
ANTHROPIC_API_KEY=sk-ant-...      # ← ваш ключ; без него мозг в стаб-режиме
```

Остальное опционально: без `OPENAI_API_KEY` эмбеддинги идут на детерминированный
hash (retrieval работает, качество ниже); без `DEEPGRAM_API_KEY`/`ELEVENLABS_API_KEY`
голос в mock-режиме.

## 3. База данных

Сервер **поднимается и без БД** (всё деградирует in-memory; теряется
персистентность между рестартами). Бэкенд выбирается по `DATABASE_URL`.

### Вариант A (АКТИВНЫЙ) — нативный PostgreSQL 18 + pgvector ✅

На этой машине уже настроено и проверено: PG18 на :5432, БД `jarvis`,
расширение **pgvector 0.8.2** (скомпилировано под MSVC), все таблицы §13 + seed.
`.env`: `DATABASE_URL=postgres://postgres:***@localhost:5432/jarvis`.

```powershell
pnpm db:migrate     # схема §13 + seed (идемпотентно)
pnpm dev:server     # db: configured, эпизодическая память — pgvector
```

**Как был установлен pgvector** (воспроизводимо; нужен VS C++ Build Tools):
```powershell
# 1) создать БД
$env:PGPASSWORD='<пароль postgres>'
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE jarvis;"
# 2) собрать pgvector (vcvars64 + nmake)
git clone --branch v0.8.2 --depth 1 https://github.com/pgvector/pgvector.git $env:TEMP\pgvector
cmd /c 'call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" && set "PGROOT=C:\Program Files\PostgreSQL\18" && cd /d %TEMP%\pgvector && nmake /F Makefile.win'
# 3) скопировать vector.dll → PG\lib, vector.control + vector--*.sql → PG\share\extension (АДМИН)
# 4) включить расширение
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d jarvis -c "CREATE EXTENSION vector;"
```

### Вариант B (fallback) — встроенный PGlite, без установки

Если нативный Postgres недоступен — в `.env` раскомментировать
`DATABASE_URL=pglite://.../infra/pgdata`. Это настоящий Postgres+pgvector в WASM,
персист на диск, без Docker/админа/компиляции. Ограничение: один процесс на datadir.

### Вариант C — Postgres на вашем Ubuntu-сервере (для прод, spec-aligned)

По спеке (§1) сервер живёт на Ubuntu. Там pgvector ставится одной командой —
без компиляции:

```bash
sudo apt-get install -y postgresql-16 postgresql-16-pgvector
sudo -u postgres psql -c "CREATE ROLE jarvis LOGIN PASSWORD 'jarvis';"
sudo -u postgres psql -c "CREATE DATABASE jarvis OWNER jarvis;"
```

Затем в `.env` указать `DATABASE_URL=postgres://jarvis:jarvis@<IP>:5432/jarvis`
(открыть порт/туннель) и `pnpm db:migrate`.

### Вариант D — без БД (быстрый старт)

Закомментируйте `DATABASE_URL` в `.env`. Всё работает, но без персистентности.
Корректность схемы при этом доказана интеграционным тестом (раздел 5).

## 4. Запуск сервера

```powershell
pnpm dev:server     # Fastify + WS gateway на :8787, /healthz для проверки
```

С заполненным `ANTHROPIC_API_KEY` agent-loop (§7) делает реальные вызовы Claude;
без ключа — детерминированный стаб (сервер не падает).

## 5. Тесты

```powershell
pnpm -r typecheck        # типы по всем пакетам
pnpm -r test             # 217 тестов (вкл. интеграционный тест БД на PGlite)
```

Интеграционный тест `apps/server/src/db/persistence.integration.test.ts` гоняет
**реальные миграции** через PGlite (Postgres+pgvector в WASM, без Docker/админа)
и доказывает round-trip для episodic/skills/action_log/usage_quota.

## 6. Клиент Electron (опционально)

```powershell
pnpm dev:client
```

## 7. C#-сайдкар (управление Windows, §6) — нужен .NET 8 SDK

```powershell
winget install Microsoft.DotNet.SDK.8
cd apps/sidecar-win
dotnet build -c Release
```

Сайдкар даёт UIAutomation-грундинг и SendInput; без него актуаторы деградируют.
