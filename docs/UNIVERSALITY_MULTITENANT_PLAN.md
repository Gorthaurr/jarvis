# Универсальность (инсталлер везде) + Мультитенант — план (аудит 2026-06-20, 92 находки)

> Запрос: код НЕ должен быть залочен на машину/имя/ключи Антона — дал инсталлер, везде работает.
> Плюс хранить авторизацию, пользователей, подписки, ключи, настройки (мультитенант).
> Категории: missing-multitenant 22, single-user 18, key-hardcode 18, machine-path 14, installer-gap 12, os-lock 8. High: 57.
> Windows-only — ОСОЗНАННО (десктоп-ассистент), но пути НЕ должны зависеть от имени `anton`/диска `C:`.

## ✅ B2 СДЕЛАНО (2026-06-21, server 699 / client 118 зелёные, typecheck чистый, живой E2E 6/6)
> Дизайн через adversarial-панель (3 угла → синтез). ВЫБРАН «честный минимум»: на loopback токен —
> КЛЮЧ ПАРТИЦИИ, не auth (секрет/HMAC = театр, локальный процесс переиграет). Реальная граница = bind.
- **Миграция `0003_auth_tokens.sql`** (token_hash PK, user_id FK, label, created_at, last_seen_at, expires_at) —
  идемпотентна, PGlite-safe; применена на PGlite (интеграц.тест) И нативном Postgres (db:migrate). ДРЕМЛЕТ
  на дефолте (используется только при `JARVIS_AUTH_STRICT=1`).
- **`db/users.ts`** (SRP, null-safe): `sha256hex`, `ensureUser` (INSERT users ON CONFLICT — закрывает FK
  Hazard 1 ДО per-user записей), `recordToken` (TOFU/last_seen upsert), `findUserByTokenHash` (свежие токены).
- **`identity.ts resolveAndProvision`** (async-обёртка над чистым `resolveUserId`): UUID→партиция+provision;
  strict+БД-up+нет строки→null (reject 4003); strict+БД-down→fail-OPEN (не брикуем локального юзера);
  не-UUID→dev-фолбэк. DB-down везде graceful (инвариант «работает без БД» цел).
- **`server.ts`**: `doHandshake` → async; single-flight латч `handshakeStarted` (sync до await) +
  `clearTimeout` до await (медленный async не роняет 5с-таймаут); новая ветка 4003 (gated strict);
  `ensureUser` ДО `createOrResume`. Bind-гард в listen (`gateway/bind.ts resolveBindHost`): не-loopback
  без `JARVIS_ALLOW_REMOTE` → принудительно 127.0.0.1 + error.
- **Клиент `identity-store.ts`**: per-install UUID ОПТ-ИН за `JARVIS_CLIENT_IDENTITY` (плоский JSON,
  атомарно, кеш на процесс); дефолт → undefined → `token = JARVIS_CLIENT_TOKEN || installId || 'dev-token'`.
  Дефолт НЕ меняет поведение → существующая установка остаётся DEV_USER, нулевая потеря данных.
- **`.env`/`.env.example`**: HOST `0.0.0.0`→`127.0.0.1`; документированы JARVIS_CLIENT_IDENTITY/
  JARVIS_AUTH_STRICT/JARVIS_ALLOW_REMOTE/JARVIS_DEV_USER_ID (дефолты безопасны).
- **Тесты**: identity (+5 no-DB), db/users (PGlite интеграция: provision/strict reject+accept/FK/
  континьюити-канарейка/конкурентность/sha256-вектор), bind (5), client identity-store (3).
- **⚠️ B2 безопасен к отгрузке СЕЙЧАС** (флаг off → дефолт неизменен). «Вооружение» UUID
  (`JARVIS_CLIENT_IDENTITY` по умолчанию) — ТОЛЬКО в одном релизе с B3, не раньше (иначе латентные
  утечки сторов станут реальными). Открытый продуктовый вопрос: opt-in навсегда vs изоляция-по-дефолту
  для НОВЫХ установок (дефолт синтеза — opt-in).

## ✅ B4 СДЕЛАНО (2026-06-21, фундамент, тесты 13 + живой E2E) — per-user шифр-ключи
- `db/crypto.ts` — AES-256-GCM. Мастер-ключ: env `CREDENTIALS_MASTER_KEY` (hex-64/base64/passphrase→sha256)
  → иначе self-bootstrap keyfile `dataDir/credentials-master.key`. Нет ключа → честный null (не пишем
  секрет открытым). Блоб [IV12][tag16][ct]; подмена/неверный ключ → null (GCM auth).
- `db/credentials.ts` — DAO: `setCredential`(шифр at-rest)/`getCredential`(дешифр)/`resolveUserKey`
  (per-user → .env-дефолт)/`listCredentialServices`. Миграция `0004` (UNIQUE user_id,service → upsert).
- Клиент→сервер: протокол `client.keys` + `transport.sendKeys` + router-ws handler (setCredential, значения
  не логируем) + `index.ts settingsSave` маппит KeyName→service. Ключи остаются и локально (safeStorage).
- Тесты: crypto 7 (round-trip/IV/неверный ключ/подмена/passphrase/bootstrap), credentials 6 (PGlite:
  шифр≠plaintext/upsert/изоляция/резолвер/list). ЖИВОЙ: client.keys→user_credentials шифр-BYTEA (64B, без plaintext).
- **ДРЕМЛЕТ (hosted follow-up):** provider hot-swap — использование per-user ключа на call-time LLM/STT/TTS
  (провайдеры замораживают ключ на конструкции). На одиночной установке .env-ключи и есть ключи юзера
  (как dormant auth_tokens B2). Резолвер `resolveUserKey` готов — вткнуть в провайдеры в hosted-режиме.

## ✅ ЖИВОЕ ТЕСТИРОВАНИЕ (2026-06-21, реальный LLM + команды, батарея 23 кейса ×2)
- Прогон реальными запросами к Opus + командами (text-driver). Команды исполняются ВЕРНО: имя из БД,
  математика, память, web-search (Гукеш ✓), web-fetch, mcp-github (VS Code ✓), app.launch/browser.open/
  system.volume, режимы/эмоции, смета (multi-step), reminder. Медленный (реалистичный) темп — всё чисто.
- **ФИКС (юзер-видимый):** под нагрузкой батареи не-стримовый `complete()` с тяжёлым кеш-промптом не
  укладывался в SDK `timeout:10с` → `Request timed out`→стаб «связь прервалась». Поднял до 60с env-тюнингуемо
  (`JARVIS_LLM_TIMEOUT_MS`, голос защищён stall-watchdog'ом 25с). Прогон-2: 0 «связь прервалась» (было ≥1).
- **ФИКС (идемпотентность):** под агрессивным rapid-fire тот же reminder-ход наслаивался → set_reminder ×2
  («одно задвоилось»). `ReminderService.add` дедупит идентичный текст+fireAt в окне (`JARVIS_REMINDER_DEDUP_MS`,
  деф 15с) — корректная семантика «напомни X в T»=одно. +2 теста. Медленный темп и так давал одно.
- **АРТЕФАКТ харнесса (не баг):** ответы фоновых задач (web/mcp >8.5с) приходят после settle → харнесс
  приписывает их след. команде. В реальном голосе — корректный отложенный ответ (мгновенный ack + итог).
- **ОТКРЫТО (load-only, для отдельного захода):** корень двойного диспатча фонового хода под наслоением
  (идемпотентность reminder его маскирует; проверить telegram_send и пр. на тот же класс).

## ✅ B5a СДЕЛАНО (2026-06-21, server 714 зелёный) — per-user SpendGuard
- `billing/index.ts SpendGuards` — реестр гвардов по userId (ленивая Map). РАНЬШЕ был ОДИН глобальный
  SpendGuard БЕЗ userId → (1) траты всех тенантов в одном счётчике, (2) persist usage_quota МЁРТВ
  (persistUsage/hydrate — no-op без userId) → месячный потолок обнулялся каждым рестартом. Теперь
  гвард на пользователя, каждый персистит свой `usage_quota` по (user_id, period).
- Проводка: `BrainProviders.spend: SpendGuards`; `agentDeps.spend = brain.spend.forUser(session.userId)`;
  hydrate per-user в handshake (ДО первого check); `drainAll()` в close; boot-hydrate убран. SpendGuard
  (класс) не менялся — он уже userId-готов. +4 теста (изоляция трат/kill-switch, hydrate/drain no-op).
- **ОСТАЛОСЬ B5b (UI, отдельный заход):** read-only протокол-сообщение `server.usage` {plan, spent,
  cap, remaining, limits, killSwitch} + client IPC + биндинг вкладки «Оплата» (renderer `#planName`/
  `#planBalance` сейчас статика, кнопка «Управление подпиской» без хендлера). Опц.: таблицы plans/
  subscriptions (usage_quota уже несёт spend_cap/kill_switch/*_limit — можно гнать лимиты оттуда).
  §0-p5: без карточных/платёжных данных, только аудит.

## ✅ B3 СДЕЛАНО (2026-06-21, server 710 / client 118 зелёные, живой 2-юзер смоук партиции)
> Партиция сторов по userId — ОБЯЗАНА лежать вместе с B2 (сегодня все = DEV_USER, утечки латентны;
> при «вооружении» UUID стали бы реальными). Эталон — working-store.ts fileFor(userId).
- **`brain/profile.ts`** (утечка #1, HIGH): был ОДИН module-global `cache` без userId (2-й юзер
  перетирал имя/факты 1-го). Стало `Map<userId,Profile>` + файл на юзера; КОНТИНЬЮИТИ: DEV_USER →
  legacy `data/profile.json`, прочие → `data/profile/<id>.json`. `loadProfile(userId)` зовётся в
  handshake ДО makeSessionContext; getProfile/setX берут userId. Call-sites (agent ×4, router-ws ×6,
  server онбординг) обновлены. +profile.test (5). **Живой 2-юзер смоук: Антон/Мария в РАЗНЫХ файлах.**
- **`memory/resolution-memory.ts`** (утечка #2, HIGH — wrong-recipient): ключ был
  `${channel}:foldName(q)` без userId → «Катя» одного уходила в peerId другого. Стало
  `${userId}:${channel}:foldName(q)`; ResolvedEntry.userId; recall/remember/forget берут userId;
  restore: legacy без userId → dev. dispatch.ts прокидывает ctx.userId. +тесты (кросс-юзер изоляция).
- **`proactive/reminders/`** (утечка #3, HIGH — чужое в чужую сессию): `speakerFor` падал в ЛЮБУЮ
  сессию (any-speaker fallback), `flushPending`/`awaitingDelivery` без userId-фильтра. Стало:
  speakers с владельцем-userId; доставка только ТОМУ userId (точная сессия → любая сессия того же
  userId → undefined, НИКОГДА чужому); flush/awaitingDelivery по userId (reconnect=новый sessionId).
  registerSpeaker(sessionId,userId,speak). +2 кросс-юзер теста.
- **`brain/tools/dynamic.ts`** (утечка #4, MEDIUM-HIGH — шаринг code-exec): самописные тулзы были по
  имени без владельца → инструмент одного юзера вызывался агентом другого. Стало: ключ
  `${userId}::${name}`, все методы (create/remove/has/list/render/asToolSchemas) берут userId, лимит
  пер-юзер, persist с полем userId (один файл), legacy без userId → dev. dispatch+agent прокинули
  userId. +тесты (кросс-юзер изоляция, континьюити).
- **Уже партиционно-корректны:** episodic (where user_id), skills (PK user_id,id), working-memory
  (fileFor), consent (ключ с userId), tasks (фильтр по userId).
- **⚠️ ОТЛОЖЕНО (дормант):** `voice/speaker/store.ts` — голоса по имени, БЕЗ userId. Гейт диктора
  СЕЙЧАС ВЫКЛ (`JARVIS_SPEAKER_GATE=0`, биометрия отклоняла владельца) → утечки на практике нет.
  Партиционировать вместе с переработкой биометрии (банк векторов+AS-Norm), не раньше.

## ✅ СДЕЛАНО (2026-06-20, тесты зелёные: server 653 / client 113)
- **A1 — резолвер `dataDir()`** (`apps/server/src/paths.ts` + тест): `JARVIS_DATA_DIR` (инсталлер → `%APPDATA%/Jarvis`) → иначе дефолт `cwd/data` (поведение dev НЕ меняется, данные не теряются — проверено на boot). 9 сторов переведены: profile/working/task/resolution/consent/reminders/skills/voices/dynamic. Инсталлеру достаточно выставить один env.
- **A3 (баг) — `profileDir()` regex**: был `/^[ -]*$/` (матчил только пробел/дефис → детект кириллицы мёртвый, всегда фолбэк `C:\JarvisData`). Стало `/^[ -~]*$/` (printable ASCII) — теперь кириллическое имя юзера (`C:\Users\Антон`) реально детектится → фолбэк на ASCII-путь работает (иначе IndexedDB webK ломается).

## A — УНИВЕРСАЛИЗАЦИЯ (осталось)
- **A0 (гигиена, НЕ блокер):** `.env` уже в `.gitignore` и НЕ трекается git (проверено) — ключи не в коммите. Перед раздачей инсталлера: **ротировать локальный пароль БД** (он ранее попал в этот файл открытым текстом и был запушен — сменить обязательно) и ключи, pre-commit hook на `sk-ant-`/`gho_`, `.env.example` только плейсхолдеры (уже так).
- **A2 — поиск `.env` устойчив к установке** (`index.ts loadEnv` ищет вверх от cwd → ломается в `Program Files`): цепочка `JARVIS_ENV_PATH` → `%APPDATA%/Jarvis/.env` → рядом с exe → cwd. Без ключа — честный warn, не молчаливый стаб.
- **A3 — резолв Chrome/сайдкара/модели** (детект, не хардкод): `stealth-tg.mjs:16-17` (хардкод Chrome + `C:\Users\anton`) → `chromeCandidates()`/`profileDir()`; `profileDir` вынести в shared и применить к ВИДИМОМУ браузеру тоже (browser-cdp берёт реальный профиль с кириллицей); сайдкар `index.ts:461` (`process.resourcesPath` первым, имя `SidecarWin.exe`); sherpa-модель `JARVIS_SPEAKER_MODEL` → `dataDir()/models`.
- **A4 — bind `127.0.0.1` по умолчанию** (сейчас `0.0.0.0` → LAN-сосед исполняет команды без auth) + Electron `requestSingleInstanceLock()`.
- **A5 — авто-миграции БД на boot** (идемпотентные, `IF NOT EXISTS` уже есть) — иначе на новой машине нет таблиц. PGlite dataDir вынести в env (НЕ ломая существующий `cwd/infra/pgdata`).

## B — МУЛЬТИТЕНАНТ (схема БД УЖЕ готова «на вырост»)
Корень всех 30+ находок: **`server.ts:462 const userId = "0000…0001"` для ВСЕХ** + single-user JSON-сторы. Схема `infra/migrations/0001_init.sql` УЖЕ мультитенантна: `users`, `user_credentials` (per-user шифр. ключи), `sessions`, `usage_quota` (подписки/лимиты/kill-switch), всё партиционировано по `user_id`.

- **B1 — схема (новые миграции, не трогать 0001):** `auth_tokens(user_id, token_hash, expires_at)`, `plans`, `subscriptions(user_id, plan_id, status)`, `user_settings(user_id PK, language/context/preferred_tier/stt/tts/spend_cap)`; перенести consent/resolutions/reminders/speaker_profiles в таблицы (user_id FK). `user_credentials` использовать для per-user API-ключей (`service`+`encrypted_blob`, мастер-ключ `CREDENTIALS_MASTER_KEY`, генерить на first-run в `.env.local`). `0002_seed_dev.sql` — только при `NODE_ENV=development`.
- **B2 — аутентификация (корень):** клиент на first-run генерит userId (UUID v4), хранит в Electron `safeStorage`, шлёт в `client.hello.token` (поле уже есть, игнорируется). Сервер `server.ts:462`: `validateToken(token)→userId` + lazy-provision `INSERT users ON CONFLICT DO NOTHING`; невалид → `unauthorized`+close; dev-фолбэк через env `JARVIS_DEV_USER_ID`, не хардкод.
- **B3 — партиция сторов по userId:** эталон — `working-store.ts fileFor(userId)`. Применить ко всем (profile-кэш `Map<userId,Profile>` — сейчас глобальный синглтон, второй юзер перезаписывает имя первого; resolution-memory ключ + userId — иначе «Катя» утекает между юзерами). Либо перенести в БД-таблицы (часть уже есть: tasks/episodic/skills/contacts).
- **B4 — per-user ключи горячо:** загрузка из `user_credentials` (с фолбэком на `.env` как платформенный дефолт); клиентский SettingsStore (ключи в safeStorage) → передавать на сервер шифрованно, сервер кладёт в `user_credentials`. Сейчас ключи UI никуда не доходят, провайдеры берут только `.env` на boot.
- **B5 — подписки:** `usage_quota` (есть) → план/баланс/лимиты; вкладка «Оплата» (сейчас заглушка) → реальные данные.

## Порядок
A0(перед раздачей) → A2,A3,A4,A5 (универсализация инсталлера) → B1,B2 (схема+auth — корень) → B3,B4 (партиция+ключи) → B5 (подписки).
B2 (auth) и B4 (крипто-ключи) — security-sensitive: делать сфокусированно, не в спешке, с тестами.
