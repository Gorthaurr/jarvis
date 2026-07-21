# Jarvis — карта системы (ЧИТАТЬ В НАЧАЛЕ КАЖДОЙ СЕССИИ)

> 🔴 **ЧИТАТЬ ПЕРВЫМ: [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)** — МЕХАНИЗМЫ + **КАК Я ТЕСТИРУЮ САМ
> (текст-драйвер `_jarvis_cmd.mjs`, dev-эндпоинты)** + мышление. Я действую как опытный ML/IT инженер:
> корень не симптом, верификация (тесты+живой прогон), сам тестирую текстом — НЕ прошу пользователя
> говорить голосом. Этот файл (CLAUDE.md) — карта файлов; HOW_IT_WORKS — механика и операционка.
>
> **ПРАВИЛО:** этот файл — единый источник «что/где/как» по Джарвису. **Меняешь архитектуру —
> обнови этот файл в том же изменении.** Устаревшая карта хуже отсутствующей. Глубокие детали —
> в `docs/` (HOW_IT_WORKS.md, ARCHITECTURE.md, JARVIS_SPEC.md, STATUS.md, NEXT_SESSION.md) и в авто-памяти
> (`MEMORY.md` → project_jarvis_*).

## Что это
Голосовой ИИ-ассистент-мажордom («Джарвис» у Старка) для ОДНОГО пользователя на его Windows-ПК.
Слышит речь → понимает намерение → **управляет компьютером инструментами** → отвечает голосом.
**Мозг — облачный Claude:** слабый тир Sonnet 4.6 (дефолт ходов), эскалация на Opus 4.8 при застревании
(§7-каскад, 2026-06-23). Тонкий клиент + облачные нейро-сервисы (STT/TTS/LLM).

### КОНЦЕПЦИЯ (критично для любых правок)
- **НЕ хардкодить шаги под сценарии.** Даём мощные, надёжные, ЧЕСТНЫЕ инструменты — модель сама
  хорошо ими пользуется. Актуатор резолвит из источников истины ОС и честно сообщает провал; что
  не вышло — модель добирает сама (`web_search`/`code_run`).
- **Честность по ошибкам — закон.** Инструмент НИКОГДА не возвращает ложный успех. Провал → ошибка
  → Джарвис говорит «не вышло», а не «Готово» (см. error-voice ниже).
- **Автономность/самообучение, не god-objects.** ООП, SRP, модули <150 строк, общие компоненты, DRY.
- **НЕ чат-бот.** Голос — узкий канал; запрет текстового ввода-как-основного (см. project_jarvis_concept).

## Запуск (грабли — см. project_jarvis_infra)
- Сервер: из `apps/server` → `npx tsx src/index.ts` (Fastify+WS на **порту 8787**). НЕ `tsx watch`
  (падает EADDRINUSE на правках — рестарт вручную: убить процесс на 8787 → запустить). Грузит `.env`.
- Клиент: `pnpm --filter @jarvis/client start` (или `dev` = пересборка esbuild + electron). Electron
  запускать БЕЗ редиректа stdio. После правок .ts клиента — пересборка (`node scripts/build.mjs`).
  - **Расширение** (`apps/extension`, MV3 SW) теперь ТОЖЕ собирается этим `build.mjs` (esbuild iife-бандл
    `background.js` + `modules/*.js` → `dist/background.js`; manifest `service_worker`→`dist/background.js`,
    §ревью-split 2026-06-30). Исходник = `background.js` (entry: WS-ядро `connect/handle`/синхронные top-level
    листенеры + single-ws синглтон — НЕ выносить) + `modules/` (utils/tab-find/cookies/keep-alive вынесены; инжекторы
    self-contained, остаются в entry). Бандл ловит оборванные импорты (node --check — нет). После правок расширения —
    пересборка + **reload в `chrome://extensions` + смоук** (боевые инжекторы Telegram/browser_act проверяются ТОЛЬКО живым Chrome).
- C#-сайдкар (`apps/sidecar-win`): UIA-грундинг + запись навыков показом. `SidecarWin.exe` собран на диске.
- БД: нативный PostgreSQL 18 + pgvector (`DATABASE_URL` в .env); фолбэк — PGlite. Docker НЕ используется.
- Тесты: `apps/server` `npx vitest run` (≈1023), `apps/client` `npx vitest run` (≈138). Typecheck: `npx tsc --noEmit`. Линтера нет.
  - **Гигиена данных (аудит 2026-07-02):** `apps/server/vitest.setup.ts` ставит изолированный `JARVIS_DATA_DIR`
    во временную папку на прогон — тесты НЕ пишут в боевой `apps/server/data` (раньше засоряли стор фикстурами
    `learned__test-distillyacii-*`, «Полить кактус», напоминания «Конец теста»). Тестам со своим каталогом
    (crypto/credentials) переопределять env — их право.
- **Наблюдаемость (аудит 2026-07-02):** durable логи в `dataDir/logs/` — `server-YYYY-MM-DD.log` (JSONL, ротация
  по дню, retention `JARVIS_LOG_RETENTION_DAYS` деф 7) + `metrics.jsonl` (одна строка на задачу: латентность/
  стоимость/токены/ok). Раньше сервер писал ТОЛЬКО в консоль → каждый разбор «вчера не сработало» был слеп.
  Файловый sink: `obs/file-log.ts` (буфер+флаш, fail-safe) через `addLogSink` в @jarvis/shared; JSONL-метрики:
  `MetricsCollector.enableJsonl()`. Выключатели `JARVIS_FILE_LOG=0`/`JARVIS_METRICS_JSONL=0`. Поднимается в
  `gateway.listen()`, dispose в `close()`.
  - **СКРЫТЫЕ ДЕГРАДАЦИИ (пункт-6 плана, 2026-07-21):** read-инструмент отработал БЕЗ ошибки, но не дал пользы
    (`ok=true`, ошибки нет) → «почему недоработал» было невидимо. `MetricsCollector.recordDegradation(kind,meta)`
    пишет durable `type:"degradation"` (fail-safe, не в ОЗУ-окно). Точки (`handlers/info.ts`): пустой `web_search=[]`
    → `web_search_empty{query}`; `knowledge_consult` без совпадения раздела → `knowledge_miss{domain,query}`.
    Осознанно: query капнут 120 (single-user local, уже в server-логах); memory-пустота НЕ логируется (частая у
    нового юзера — шум). Ревью 7→0.
  - **Гигиена/здоровье (ревью learn-coding-agent 2026-07-15):** (1) `metrics.jsonl` РОС без предела —
    `pruneOldLogs` чистит по возрасту ТОЛЬКО `server-*.log` (это ЦЕННАЯ longitudinal-экономика `/cogs`, по
    возрасту удалять нельзя). Теперь ротация ПО РАЗМЕРУ: `>JARVIS_METRICS_MAX_BYTES` (деф 64 МБ) → сдвиг в
    `metrics.jsonl.1` (одна прошлая генерация), диск ~2×cap; счётчик байт в ОЗУ (ленивая init от файла),
    сброс ТОЛЬКО при успешном rename (провал на Windows-локе → повтор на след. записи, бонд держится). Единый
    писатель `appendJsonl` (DRY, был дубль в record/recordRound/recordMouthToEar). (2) `startProcessHealth()`
    (из `listen()`, стоп в `disableJsonl`) — durable строка `type:"process_health"` (rss/heap/uptime/cpu/node)
    раз в 5 мин: корреляция при регрессе памяти/CPU (был слеп на «оглох/OOM»). (3) file-log sink: кап `meta`
    (`META_MAX_CHARS` 8192) — крупный payload не раздувает дневной лог.

## Карта репозитория (pnpm monorepo)
- `packages/protocol/src/actions.ts` — ActionCommand/ActionResult (контракт server↔client).
- `packages/tools/src/index.ts` — **ВСЕ инструменты** (JSON-схемы Anthropic tool-use). Тут добавлять инструмент.
- `packages/shared` — логгер, AsyncMutex, Semaphore, типы, **`name-match.ts`** (кросс-скрипт резолв
  получателей §13: `nameSearchVariants`/`pickRecipient`/`foldName`/`transliterate` — Герман↔Herman; ⭐
  ПРИНЦИП: транслитерация = recall, РЕШЕНИЕ при неоднозначности — модель, не таблица).
- `apps/server/src` — МОЗГ (см. ниже).
- `apps/client/main` — Electron main: транспорт, **актуаторы**, tier0, аудио/vad/wake, сенсоры.
- `apps/client/renderer` — UI (орб состояния, карточки, **вкладка «Чат» §22**, кнопка mute). `renderer.ts`
  (312 строк, был god-object 811 — разобран §ревью 2026-06-30) = ФУНДАМЕНТ (DOM-init, орб/состояние, карточки,
  аудио+чат playback-узел, панель настроек) + вызовы `init<Панель>(jarvis)`. Кластеры вынесены в модули рядом:
  `dom.ts` (общий `$`), `wave.ts`, `task-panel.ts` (§20 чипы), `monitor-panel.ts` (§6), `billing-panel.ts` (§6B/B5),
  `confirm-dialog.ts` (§14) + `focus-trap.ts` (общий a11y), `skill-recorder.ts` (§8, settingsPanel через DI-коллбэк),
  `voice-enroll.ts` (§3), `list-item.ts` (общий `buildListItem`, дедуп строк навыки↔голоса). Паттерн: jarvis-мост
  аргументом init (DI), модули импортируются обратно односторонне (renderer = esbuild IIFE-entry, 0 value-экспортов
  → циклы исключены). DOM-юнит-тестов нет (нет jsdom) → выносы делались чистым move + tsc + esbuild на каждом шаге.
  - **H18-фикс `audio.ts` (2026-07-02, «оглох навсегда»):** провал реинита захвата (игра держит
    устройство → getUserMedia кидает) больше не молчит — таймер-ретрай с бэкоффом 1с→30с (после stop()
    трека нет, события mute/ended не придут — только таймер вернёт слух); `ensureCapture` (renderer.ts)
    при частичном провале start() добивает захват (не держит MediaStream). Тесты в `renderer/audio.test.ts`
    (браузерные глобалы — заглушки, без jsdom).

## Сервер (`apps/server/src`)
- `gateway/server.ts` — boot: поднимает провайдеры (BrainProviders), WS `/ws` (клиент) и `/ext`
  (расширение Chrome), heartbeat, hydrate (profile/consent/dynamicTools/spend/**reminders**).
  - **§6B/B2 ИДЕНТИЧНОСТЬ+AUTH (честный минимум, 2026-06-21):** `doHandshake` АСИНХРОННЫЙ; токен →
    `identity.ts resolveAndProvision` (async-обёртка над чистым `resolveUserId`): UUID→партиция +
    lazy-provision `users` (`db/users.ts ensureUser` ON CONFLICT — ДО `createOrResume`, закрывает FK
    Hazard 1); strict (`JARVIS_AUTH_STRICT=1`, дефолт off) сверяет sha256(token) с `auth_tokens`
    (миграция 0003), нет строки→4003 (**fail-CLOSED всегда, вкл. БД-down — ревью 2026-07-04, M1**:
    strict = hardened/remote контекст, лучше отвергнуть, чем впустить непроверенного; `isDbReady()`
    теперь реальный `SELECT 1` с кэшом, а не проверка «объект пула существует»). Single-flight латч
    `handshakeStarted` (sync до await). ⚠️ На loopback токен = КЛЮЧ ПАРТИЦИИ, НЕ auth (секрет театр);
    реальная граница — bind (`gateway/bind.ts resolveBindHost`: не-loopback без `JARVIS_ALLOW_REMOTE`→
    127.0.0.1+error). Клиент: per-install UUID ОПТ-ИН за `JARVIS_CLIENT_IDENTITY` (`identity-store.ts`),
    дефолт = 'dev-token' → DEV_USER (существующая установка цела). «Вооружение» UUID — только с B3.
- `gateway/router-ws.ts` — `makeSessionContext` (per-connection): создаёт VoicePipeline + agentDeps,
  `getVoiceOpts` (голос режима+**эмоция**), регистрация озвучки напоминаний, dispatch входящих кадров.
- `gateway/session.ts` — Session (send/sendAction/requestConfirm), resume.
- `brain/agent/index.ts` — **ядро**: `handleUserText` → детерминированные перехваты (имя, режим-маска,
  **эмоция**) → tier0 (`runLocalIntent`) / `runAgentLoop` (LLM + tools, эскалация тира §7, anti-runaway,
  фоновые задачи §20). Терминал: честный провал вместо ложного «Готово» (`error-voice.ts`).
  - **ГАРД КОНТЕКСТ-ОКНА (hardening, ревью learn-coding-agent 2026-07-15):** промпт растёт с каждым tool-
    раундом (крупные web/OCR/browser-дампы) → на патологически длинной задаче следующий раунд мог упереться в
    ЖЁСТКИЙ HTTP 400 (max context ~200K) на середине. `lastPromptTokens` (реальный размер прошлого промпта =
    input+cache_read+cache_creation) в блоке бюджета: `>=CONTEXT_HARD_TOKENS`(деф 185K) → ранний ЧЕСТНЫЙ свёрток
    (`contextWrap`, подвид timedOut, ok=false, «перестала помещаться в память»); `>=CONTEXT_SOFT_TOKENS`(деф 150K)
    → одноразовый нудж «сворачивайся». Детерминированно, БЕЗ LLM-суммаризации (та ломала бы prompt-кеш §15 и
    могла выбросить состояние экрана → ложный успех — почему autoCompact у Claude Code сознательно НЕ берём).
    Watermark отстаёт на раунд (headroom ~15K гасит типовой прирост); env `JARVIS_CONTEXT_SOFT/HARD_TOKENS`.
    - **PROACTIVE (аудит контекста 2026-07-20):** реактивный гард (watermark прошлого раунда) мог пропустить
      ОДИН раунд с ~9-16 параллельными чтениями (web_fetch/browser_read по 8000 симв) + screen_capture — прирост
      больше headroom → 400 РАНЬШЕ, чем гард увидит. Теперь `projectedPromptTokens = lastPromptTokens +
      pendingResultTokens`, где `pendingResultTokens = estimateResultTokens(resultBlocks)` — оценка результатов
      ЭТОГО раунда, ещё не учтённых в usage (текст /2.5 — КОНСЕРВАТИВНО под кириллицу: занижение → 400, переоценка
      бесплатна; скрин ≈2000). Reset после реального usage, set после `convo.push`. Проекция монотонна (≥
      lastPromptTokens → срабатывает не позже прежнего; короткие задачи не затронуты). Ревью: тайминг/reset/
      двойной-счёт/регресс/честность чисты; F8 — делитель 3.5→2.5 (кириллица плотнее латиницы).
  - **СТРУКТУРНЫЙ verify/анти-капитуляция (P0, 2026-06-30, корень «сдаётся+врёт готово»):** петля больше
    НЕ верит первому терминальному тексту. `anyMutateSucceeded` (успех ТОЛЬКО `toolEffect==="mutate"`, не
    нейтрального web_search) гейтит анти-капитуляцию и masked-failure → «погуглил и сдался»/«нейтральный
    поиск → ложное Готово» ловятся. Verify-нудж теперь по СТРУКТУРЕ — `blindMutatePending` (после СЛЕПОГО
    действия `isBlindMutate`: input_*/browser_act/web_act/app_focus/ui_* — ok≠цель; code_run/fs/office/
    system/launch/open самоподтверждаются и сверки НЕ требуют), а не по regex `claimsObservedResult` (он
    теперь усилитель). Капы: `JARVIS_MAX_VERIFY_NUDGES`(деф 2), `JARVIS_MAX_RETRY_NUDGES`(деф 2, мин 1 —
    нельзя тихо выключить). См. [[project_jarvis_verify_loop]].
    - **ПРИМИРЕНИЕ нудж↔бюджет (аудит контекста 2026-07-20, rules; +ревью F9):** под взведённым budget/
      context-нуджем («сворачивайся») агрессивный retry-нудж «СТОП, не сдавайся, keep trying forever»
      ПРОТИВОРЕЧИЛ бюджету в соседних раундах (док. боль: преждевременный свёрток ЛИБО лишние Opus-раунды).
      `underWrapPressure = budgetNudged || contextNudged` примиряет ТОЛЬКО ТЕКСТ retry-нуджа: когерентное
      «ОДИН ход ИЛИ честный частичный итог» вместо «не сдавайся бесконечно». Opus-эскалация СОХРАНЕНА (F9:
      подавлять её нельзя — на 70% ВРЕМЕНИ бюджет ещё есть; лишить выполнимую задачу сильного шота → слабый
      Sonnet выдаст «не могу», masked-failure не ловит → ложный отказ; один шот ограничен retry-капом +
      HARD-гардом). Verify-нудж/goal-check НЕ трогаются — честностные сверки исхода (подавление = ложный успех).
    - **QUALITY-ЭСКАЛАЦИЯ + НЕМЕДЛЕННЫЙ ТАСК-ЧИП (аудит окружения 2026-07-21, ресёрч «Context Fails First»
      → жалобы «не показывает что делает» + «не заёбывается»; корень ОБОИХ — нет внешнего контракта
      прогресса):** (P0-B) §7-каскад эскалировал на Opus ТОЛЬКО failure-gated (весь раунд провалился ×2) →
      недо-ТЩАТЕЛЬНОСТЬ без ошибок инструментов до Opus не доходила. `escalateForQuality` (идемпотентный,
      липкий strongLocked) поднимает тир по КАЧЕСТВЕННОМУ сигналу — на 2-м verify-нудже подряд (модель
      ПОВТОРНО не сверила слепое действие; редкий высокосигнальный триггер). На goal-check НЕ вешаем
      (ревью cost: launchOnlyClaim ловит «открыл/включил» — частое легитимное голосовое завершение → лишний
      Opus). (P0-A) визуальный чип §20 (`emitTaskStatus`) уходил на клиент ТОЛЬКО после 1-го tool-раунда
      (2-13с лаг) или НЕ уходил на текст-ходе → теперь `showStatus()` СРАЗУ при старте содержательной задачи
      (ПОСЛЕ admission-блока, ВНУТРИ try — ревью F10/F11: очередная задача не мигает running перед queued;
      throw сборки промпта ловится → чип не осиротеет); conversational чипа НЕ получает. Ресёрч (Anthropic
      effort-doc, Chroma context-rot, Push-Your-Agent): «raise effort, not prompt-around»; «progress reporting
      attaches to subgoal completion»; «external feedback ≫ introspection». Открыто (следующий заход): effort
      по классу задачи, thinking ВКЛ на сверке, subgoal-контракт прогресса, бюджет фона.
    - **ИНТРА-РАУНДОВЫЙ `stepLabel` «что делаю сейчас» (2026-07-21, продолжение P0-A по жалобе «не видно, что
      делает»; адверс-ревью 8→0):** чип §20 нёс лишь `title`+`stepsDone/Total` — «running, шаг 3/5», но НЕ ЧТО
      именно делает. Теперь `Task.stepLabel` (+`TaskStatus.stepLabel`) обновляется в tool-цикле раунда из
      `tasks/task.stepLabelFor(name,input)` (чистая, НИКОГДА не null: процессные шаги «Читаю страницу»/«Кликаю»/
      «Смотрю на экран», browser_act play/pause делегирует actionTitle → «Воспроизведение», суть → actionTitle,
      MCP → «Внешний инструмент», незнакомое → «Работаю…»); `emitTaskStatus` шлёт stepLabel ТОЛЬКО при
      `state===running` (терминал показывает итог, не последнее действие); conversational не получает. Клиент
      `renderer/task-panel.ts` рендерит `.taskchip__action` под заголовком (скрыт, если пусто; +CSS). Метка =
      НАМЕРЕНИЕ действия, НЕ claim успеха (состояние задачи несёт успех/провал отдельно — закон честности цел).
      ⚠️ Клиентский рендер (нет jsdom-тестов) — живой смоук в Electron за владельцем; server-side stepLabelFor
      покрыт юнит-тестами (task.test.ts), проводка/emit-гейт отревьюены до нуля.
  - **ВОЛНА 1 «скорость/приёмка» (2026-07-10, план `docs/HARNESS_PLAN_2026-07-10.md`, эпизод «поиск
    в доте»: STT-повтор → 2 параллельные задачи → обе убиты потолком, $1.09):**
    (1.1) слышимая ПРИЁМКА фоновой задачи МГНОВЕННО — earcon-тон ~160мс (`voice/earcon.ts` WAV-генератор +
    `pipeline.playTaskAckEarcon`, проводка `AgentDeps.taskAccepted`; клиентский плеер сниффит RIFF;
    выкл `JARVIS_TASK_ACK_EARCON=0`); отложенный голосовой ack 8с→4с (`JARVIS_TASK_ACK_MS`); гард earcon
    полный (speaking ∨ ttsStream ∨ phraseSpeaker.active — не рвём чужой аудио-стрим);
    (1.2) дубль-гейт устойчив к STT-обрывкам (`scope.isDuplicateGoal`): стем-Жаккар (точное равенство) +
    фрагмент-overlap по ПОЛНЫМ токенам (≥0.8 + ≥1 содержательный токен; НЕ префиксы — ревью: «свет»⊂
    «светлую» давало ложные «Уже делаю») + канонизация латиницы (`shared latinToCyrillic`: dot'е→доте) +
    семантический бэкстоп e5 (`AgentDeps.embedder`, `JARVIS_DUP_SEMANTIC_MIN` деф 0.9, параллельные
    embed'ы с бюджетом 400мс) + полярность-гард на ОБОИХ слоях (стоп-команда ≠ дубль старт-цели);
    гейт СТОИТ выше steer, но только для scope=new (реджект-повтор «нет, не то…» уходит в steer);
    (1.3) очередь за арендой ввода НЕ сжигает потолок задачи (loopStartMs сдвигается на waited; в
    task-метриках `queueWaitMs` отдельно, в avg-раунд не входит); acquire с таймаутом
    (`shared Semaphore.acquireWithTimeout`, `JARVIS_INPUT_WAIT_MS` деф 60с → честная ошибка «ввод занят»);
    гард протухшего клика: после ожидания >10с слепые действия блокируются до сверки глазами (кэп 2);
    (1.4) `ui_ground`/`ui_invoke` — ГОРЯЧИЕ (из COLD убраны); `ui_ground` = НЕЙТРАЛЬНОЕ чтение (не
    blind-mutate, verify-нуджем не карается) и НЕ блокируется в браузерной задаче (MOUSE_TOOLS − ui_ground);
    (1.5) видимый бюджет: на 70% потолка — одноразовый нудж «сворачивайся» (честный частичный итог),
    остаток < среднего раунда → ранний свёрток (причина «свернулся заранее», не «превышен потолок»);
    (1.6) роутер: STT-обрывок (микс латиница+кириллица, <4 токенов, без глагола-действия) → мгновенный
    clarify «повторите» ($0, ключ `__repeat__` — следующая реплика маршрутизируется обычно), не фоновая
    петля (`router.looksLikeGarbledFragment`); confidence Deepgram пробрасывается в персистентном пути;
    (1.7) кеш-гигиена: `JARVIS_KEEP_SCREENSHOTS` деф 2→1, family-boost 1→2 раунда (амортизация перезаписи
    префикса при свитче модели), тариф записи 1h-кеша 2×input (`obs/pricing.cacheWriteRate` по
    `ANTHROPIC_CACHE_TTL` — SpendGuard больше не занижает на 37.5%), history-changelog персоны вынесен в
    `persona/persona-changelog.md` (−3K мёртвых токенов из КАЖДОГО запроса);
    (1.8) наблюдаемость: пер-раундовые строки `type:"round"` в metrics.jsonl (`metrics.recordRound`) +
    WARN «перезапись префикса» с причиной (model-switched/pruned-images/prefix-changed) + latency-марки
    на earcon (метрика «конец речи → первая обратная связь» существует).
  - **ВОЛНА 2 «структурные» (2026-07-10, план `docs/HARNESS_PLAN_2026-07-10.md` §Волна2 — все 7 пунктов):**
    (2.1) **FUSED ACT+OBSERVE** — актуаторы input_click/type/key/mouse/ui_invoke/skill.execute САМИ прикладывают
    дешёвое наблюдение ПОСЛЕ действия в ТОТ ЖЕ tool_result (клиент `actuators/observe.ts`: пауза стабилизации →
    a11y-выжимка активного окна; окно UIA-слепое → OCR региона вокруг точки; выкл `JARVIS_FUSED_OBSERVE=0`);
    сервер (`dispatch.ts` generic-путь) форматирует его untrusted-блоком и ставит `ToolResult.observed` → агент
    снимает verify-долг в ТОМ ЖЕ раунде (`blindMutatePending` не взводится при observed — строгость LAW цела,
    сверка реальная, не доверие «ok»); `browser_act`: клик ВСЕГДА DOM-диф (`changed:true/false` от инжектора;
    changed:false наблюдением успеха НЕ считается), observed при playing/currentTime/navigated/changed:true.
    Паттерн «клик→скрин→клик→скрин» схлопнут — экономика −35-50% раундов GUI-задач.
    (2.2) **`input_batch`** (HOT): ≤12 механических шагов одним вызовом → `skill.execute` с синтетическим id
    (`adhoc-batch-*`) → готовый runSkill под одной арендой, стоп на первой ошибке, честный «выполнено k из n»
    (`handlers/skills.ts inputBatch`; валидация действий ДО отправки — молчаливый no-op клиента не маскируется
    успехом; needsLlm запрещён); + петля: раунд целиком из не-GUI ЧИТАЮЩИХ вызовов (toolEffect neutral/verify)
    диспатчится ПАРАЛЛЕЛЬНО (research 2-3× быстрее; mutate/GUI — строго последовательно). Persona v72:
    «батчь механику, независимые чтения — вместе».
    (2.3) **ДЕШЁВЫЕ СЕНСОРЫ**: `screen_capture{rect,scale}` (кроп ~50-200 ток; lastMapping НЕ трогается —
    клики продолжают считаться от последнего ПОЛНОГО кадра); `screen_read_text` (HOT; ЛОКАЛЬНЫЙ OCR
    Windows.Media.Ocr в сайдкаре — клиент снимает кадр, сайдкар отдаёт текст+bbox строк, `OcrService.cs`);
    `screen_probe` (COLD; перцептивный 8×8-хеш — детектор перемен, НЕ доказательство успеха, план §4.2);
    `wait_for{condition,timeoutMs}` (HOT; клиентский поллинг БЕЗ LLM-раундов: window/ui/text(OCR)/sound(WASAPI),
    gone:true = ждать исчезновения; met:false — честный исход, met:true = observed) — `actuators/sensors-cheap.ts`;
    visual-expect макросов ОЖИЛ (client-actuator: OCR вместо безусловного false → $0-реплей для игр работает).
    (2.4) **САЙДКАР** (TFM → `net8.0-windows10.0.19041.0` ради WinRT OCR; путь exe в client/index.ts обновлён;
    смоук-тест 9/9 живьём): `ui.snapshot`→`ui_snapshot` (HOT; set-of-marks: интерактивные элементы окна
    {handle,role,name,automationId,value,bbox} ~сотни токенов вместо 2K-скрина, элементы сразу в реестре
    хендлов → ui_invoke по handle); `window.list`/`window.focus`→`window_list`/`window_focus` (HOT; EnumWindows
    без DWM-клоак; SetForegroundWindow+AttachThreadInput+ALT-нудж с ЧЕСТНЫМ readback focused; `apps.focusApp`
    теперь сайдкар-first с фолбэком на AppActivate — TODO M3 закрыт); ПОЛНАЯ МЫШЬ `input.mouse`→`input_mouse`
    (HOT; move/down/up/wheel/drag с интерполяцией, right/middle; `input_click{button,count}` — контекст-меню/
    дабл-клик; зажатые кнопки мыши в реестре удержаний watchdog'а); ground: scope дефолт АКТИВНОЕ ОКНО→фолбэк
    весь стол + nameMode="substring" + automationId; READ-опы сайдкара — в Task.Run-пуле (не блокируют ввод);
    `SidecarClient` — авто-рестарт с бэкоффом 1с→30с (сброс по аптайму 60с; stop() не рестартит).
    Классификация: ui_snapshot/screen_read_text = VERIFY; window_list/screen_probe/wait_for = NEUTRAL;
    input_mouse/input_batch = BLIND_MUTATE (+ input_mouse в MOUSE_TOOLS); input.mouse/window.focus/input_batch
    — под арендой ввода. OCR/снапшот/окна оборачиваются `<untrusted_content>` (M11: влияемые данные).
    (2.5) **ADMISSION-ОЧЕРЕДЬ GUI-задач**: GUI-boundness известна ДО петли (по recall-навыку: kindNeedsInput
    на шагах) + арбитр занят + фоновый путь → `tasks.markQueued` (честный чип «в очереди»; narrate/панель
    уже умели) + ОДИН ack «Сначала закончу текущее, сэр» + ожидание аренды ДО первого LLM-раунда
    (`JARVIS_QUEUE_WAIT_MS` деф 90с; таймаут → честный терминал «так и не приступил», НИ ОДНОГО раунда не
    сожжено); после аренды `tasks.start` (queued→running) + гард протухшего клика (форс свежего взгляда);
    дубль-гейт видит queued (повтор в очереди не плодит вторую). Без навыка признак молчит → страховка
    Волны 1 (queue-aware дедлайн в ensureInput) остаётся.
    (2.6) **STT**: (а) НОРМАЛИЗАТОР ЛЕКСИКИ `voice/lexicon.ts` (`TranscriptNormalizer`): доменная латиница →
    кириллица С СОХРАНЕНИЕМ словоформы («в dot'е.»→«в доте.»); лексикон = `routerLexicon()`
    (QUICK_ALIASES+WEB_SERVICES) ∪ client.env apps/games (ClientEnv расширен структурными списками — строку
    summary не парсим) ∪ имена/when навыков; заменяются ТОЛЬКО exact/lev≤1-узнанные токены (GitHub/ffmpeg
    не трогаются — §13-принцип «recall, не исправление»); сборка фоновая TTL 60с, normalize СИНХРОННЫЙ;
    врезка ОДНА — `pipeline.gateWake` (кроет спекулятивный эндпоинт и поздний финал; анти-дубль сравнивает
    нормализованное). (б) СЕРВЕРНЫЙ ENDPOINTING: `speech_final` Deepgram (endpointing=300) больше не
    выбрасывается → `SttPartial.speechFinal` → pipeline эндпоинтит через `turn.onProviderEndpoint`
    (семантическое вето: висящий союз/одиночное слово не рубим, порог 0.5 — тишину провайдер уже подтвердил)
    — ~350-400мс от конца речи против 520+150мс клиентского пути (тот остаётся фолбэком); выкл
    `JARVIS_STT_ENDPOINT=0`.
    (2.7) **ПЕР-РАУНДОВЫЙ THINKING** `agent/thinking-policy.ts` (`decideRoundThinking`/`stripThinkingBlocks`):
    план (step 0)/нудж/эскалация — базовый эффорт тира; механика (recall-навык, follow-up после blind-mutate)
    — off (−2-5с и сотни output-ток/раунд); fable/Opus НЕ глушится НИКОГДА (грабля §4.7); off→on ТОЛЬКО на
    текстовой границе (на хвосте tool_result включать нельзя — HTTP 400: assistant-ход с tool_use обязан
    нести свои thinking-блоки), иначе off до ближайшего нуджа; при off реплеенные thinking-блоки стрипаются
    (разовая перезапись префикса — WARN 1.8 покажет причиной prefix-changed); все 8 нудж-сайтов ставят
    `nudgeBoostNextRound`; выкл `JARVIS_ROUND_THINKING=0`. Persona v72: «между tool-вызовами текст не пиши».
  - **РЕВЬЮ ФИКСОВ ВОЛНЫ 3 — 2 РАУНДА (2026-07-11, воркфлоу 10+6+3 агента; поверх первого адверс-ревью ниже):**
    независимый повторный аудит НЕЗАКОММИЧЕННЫХ фиксов нашёл, что часть заявленных ниже фиксов закрыта НЕ до конца.
    Раунд 1 (13 CONFIRMED, все исправлены): (а) `replayUnsafe` перепроверяется ПОСЛЕ префилла (префилл мог заполнить
    пустой combo→«enter»/url→«file:» уже за гардом); (б) compose-гард ловит отправку не только Enter, но и
    input.click/input.mouse/ui.invoke после сочинения текста; (в) единый серверный потолок `skill.execute`=130с
    (`SKILL_EXECUTE_SERVER_TIMEOUT_MS`) для skill_execute/input_batch/авто-макроса — раньше skill_execute ждал 15с
    и петля кликала параллельно реплею; (г) `waitForExpect` стал WALL-CLOCK (был счётчик поллов × дорогой UIA-опрос
    12с → десятки минут за бюджет); (д) GSI: `auth.token` вырезается из стора (не утекал в контекст/логи), токен
    per-request, `recentlyGone`-окно против ложного «матч закончился» до начала матча; (е) watch-предикат:
    типы gsi-критерия коэрсятся к строке + `gone` строго boolean на постановке; (ж) PCM: сброс сирот накопителя
    и перевзвод дренаж-вотчдога на вырожденном (carry) чанке. Раунд 2 (5 CONFIRMED, все исправлены — R1..R5):
    (R1) `ui.invoke pattern="setValue"` — тоже ввод текста → в compose-гард; (R2) длинный `input.type`/`setValue`
    неотменяем (typeText даёт себе до 180с > 130с потолка) → кап `REPLAY_TYPE_MAX_CHARS`=150, реплей отменяется в
    3 эшелонах (сервер replayUnsafe + inputBatch + клиент-актуатор); (R3) пересчёт хвоста бюджета: кламп клиента
    80с, пропуск expect-опроса при исчерпанном бюджете, кламп retries из контента; (R4) STATEFUL-детект исчезновения
    gsi+gone (`Watch.sawFreshAt` durable + `gsiState` fresh/stale/none из клиента) — редкий watch-тик больше не
    промахивается мимо короткого окна `recentlyGone`; (R5) `PCM_ORPHAN_MS` 8→12с (> серверного INACTIVITY_MS 8с) и
    `last`-чанк не сбрасывает сироту — честный частичный last после inactivity-аборта звучит. Раунд 3 (1 CONFIRMED,
    R6): кап `REPLAY_TYPE_MAX_CHARS` УБРАН из общего client-actuator... **⚠️ R6 ОТМЕНЁН интеграционным ревью
    (см. запись 2026-07-12 ниже): премисса «одиночный type budget-safe» ложна для >~625 символов (77с > 130с
    потолка), поэтому кап 150 ВЕРНУЛИ на ВСЕ пути runSkill вкл. явный `skill_execute` — длинный литеральный
    текст в навыке физически не реплеится, идёт через fs_write/office_*.** Env-выключателей у фиксов нет.
    Тесты: сервер 1161 / клиент 185, +34 регресс-теста.
  - **АДВЕРСАРИАЛЬНОЕ РЕВЬЮ ВОЛНЫ 3 (2026-07-11, 4 агента: 3 файндера + верификатор; 18 находок CONFIRMED,
    0 опровергнуто — ВСЕ исправлены, +17 регресс-тестов):** ключевое, что закрыто (нарушения законов честности/
    verify/безопасности/ресурсов): (#2) реплей-макрос — клиентский runSkill теперь САМ укладывается в бюджет
    `JARVIS_SKILL_REPLAY_BUDGET_MS` (деф 90с) и честно возвращается ДО серверного потолка (130с) → нет «двух
    писателей в GUI» (LLM-петля больше не кликает параллельно ещё идущему реплею; cancel-токен M8 всё ещё заглушка,
    но гонка снята бюджетом); (#3) анти-капитуляция ставит `strongLocked` БЕЗУСЛОВНО (капитуляция на fable больше
    не даунгрейдится вниз executor-ступенью); (#4) «чистый раунд» для executor-отката = НИ ОДНОГО провала (было
    «не все упали» — смешанный раунд рос streak под провал ключевого действия) + даунгрейд гейтится
    `!blindMutatePending`; (#5) реплей browser.open/app.launch с опасной URI-схемой (file:/ms-msdt:/…) отменяется
    (обход SSRF-гарда закрыт, `replayUnsafe`); (#6) ПРЕДУСЛОВИЕ шага проверяется `checkPrecondition` в АКТИВНОМ окне
    (сайдкар scope="active", БЕЗ фолбэка на весь стол — иначе кнопка в фоновом окне давала ложный pass; nameMode
    прокинут; **сайдкар пересобран+published, смоук 11/11**); (#7) навык «сочини текст → Enter» не реплеится вслепую
    (отправка мимо send-гардов), префилл не перетирает записанные литеральные params; (#8) префилл-вызов учтён в
    SpendGuard/COGS; (#9) GSI-листенер: отказ на Origin (браузерный CSRF) / чужой Host (DNS-rebinding) / не-JSON
    Content-Type + опц. токен `JARVIS_GSI_TOKEN`; (#10) `state` капнут (32 источника, вытеснение старейшего) — нет
    OOM; (#11) `JARVIS_GSI_STALE_MS` деф 45с > heartbeat Dota 30с (конец дребезга озвучки); (#12) мёртвый predicate
    (опечатка kind / gsi без path) отвергается на постановке, не «в тишину»; (#13) gsi+gone срабатывает на
    исчезновение источника (игра закрыта → пуши смолкли → met); (#14) тик watch-сервиса параллелит проверки;
    (#15) схема watch_create every_seconds minimum 30→5 (предикат-путь достижим); (#16, critical) PCM-плеер:
    голова фразы не теряется при доигрывании предыдущей посреди приёма; (#17) live-плеер завершается по дренажу
    если last не пришёл (v3-стрим умер) + сервер шлёт last на ошибке — конец залипшего barge-окна на 90с; (#18)
    «отставший» чанк после barge-in подавляется (окно 400мс) — не звучит поверх речи; (#19) хвост v3-буфера
    дренажится; (#21) нечётный PCM-байт переносится (carry) — нет сдвига-шума; (#20) филлер под yandex3 оборачивается
    в WAV (не молчит). Env-выключателей у фиксов нет — это исправления, не фичи.**
  - **ВОЛНА 3 «кардинальная» (2026-07-10, план §Волна3 — все 6 пунктов; отревьюено 2026-07-11, см. выше):**
    (3.1) **РЕПЛЕЙ ПРЕЖДЕ ПЕТЛИ**: REPLAY_SAFE расширен (+ui.invoke/ui.ground/app.launch/browser.open/
    input.mouse/ground/verify); needsLlm-шаги ЗАПОЛНЯЮТСЯ дешёвым тиром ОДНИМ вызовом ДО реплея
    (`agent/skill-prefill.ts prefillNeedsLlmSteps` — TODO M4+ закрыт; не заполнилось → реплей честно
    отменяется, обычная петля); recall-кэш греется на boot (server.ts, DEV_USER + «прогрев») и фоновый
    путь ждёт recall дольше (`JARVIS_RECALL_TIMEOUT_MS` деф 2500 — живой эпизод срывался на холодных 700мс).
    (3.2) **EXECUTOR-СТУПЕНЬ ВНИЗ** (planner↔executor): §7-эскалация помнит `escalatedFrom`; при известной
    процедуре (recall) и ≥2 ЧИСТЫХ раундах подряд — откат на прежний дешёвый тир (новый провал снова
    эскалирует штатно). `strongLocked` (trading/анти-капитуляция — осознанная сила) вниз НЕ спускается;
    одна попытка на задачу (анти-пинг-понг кеша); anti-runaway-нуджи сбрасывают чистую серию; выкл
    `JARVIS_EXECUTOR_TIER=0`.
    (3.3) **PRECONDITIONS (паттерн UFO2)**: `SkillStep.precondition {role,name?}` — живой UIA-стейт
    проверяется ПЕРЕД шагом (runSkill), mismatch → честный стоп «дошёл до шага N» без слепых кликов
    по изменившемуся экрану; поле в схеме input_batch (валидируется в inputBatch).
    (3.4) **WATCH-ПРЕДИКАТЫ + GSI**: `Watch.predicate` (форма wait_for.condition) — проверка НА КЛИЕНТЕ
    владельца ($0, мин. интервал 5с против 30с LLM-чекера; `service.checkPredicate` шлёт короткий
    wait.for через реестр `registerActions` — router-ws регистрирует sendAction сессии); «скажи когда
    матч найдётся» = watch с предикатом, петля агента свободна сразу. + generic GSI-канал: клиентский
    HTTP-листенер `sensors/gsi-listener.ts` (127.0.0.1:`JARVIS_GSI_PORT` деф 3730, 0=выкл; тело ≤256KB)
    принимает JSON-пуши игр/программ (Dota GSI-конфиг пишет сам Джарвис по просьбе, НЕ хардкод);
    условие `{kind:"gsi", source?, path, equals/contains, gone?}` в wait_for/predicate.
    (3.5) **СТРИМ-TTS (опт-ин `TTS_PROVIDER=yandex3`)**: `integrations/yandex-tts-v3.ts` — REST v3
    utteranceSynthesis (grpc-gateway, БЕЗ gRPC-зависимостей), сырой LINEAR16_PCM 22050 чанками по мере
    синтеза (живой зонд: первый аудио-чанк 143мс); `TtsChunk/SpeakChunk` += `format:"pcm16"/sampleRate`;
    рендерер `audio.ts`: `PcmLivePlayer` (WebAudio, чанки по мере прихода, когда канал свободен) +
    занятый канал собирает PCM в WAV (`wavFromPcm16`) в обычную очередь; barge-in цел. Боевой дефолт
    остаётся v1 (`yandex`) — свап осознанно после живого прослушивания.
    (3.6) **ЛЕСТНИЦА НАБЛЮДЕНИЯ — ЗАКОН**: verify-нуджи петли называют порядок ui_snapshot →
    browser_read/inspect → screen_read_text → screen_capture (последний резерв); `context_read`
    переописан как «дешёвая текстовая сверка активного окна», не только дейксис.
  - **ПАМЯТЬ+КОНТЕКСТ уровень Б (2026-07-11, `docs/MEMORY_CONTEXT_REVIEW_2026-07-10.md` §5 Б; +42 теста):**
    (Б1) **СОН-ЦИКЛ консолидации** `proactive/consolidation.ts` — раз в КАЛЕНДАРНЫЙ день (первый коннект,
    `server.ts maybeConsolidate`, гейт `profile.lastConsolidatedAt`, dev-сессии пропускаются) фоновый
    дешёвый LLM выжимает из вчерашних реплик (working-store) + выполненных задач 0-5 УСТОЙЧИВЫХ фактов
    (жёсткий анти-мусорный промпт: одноразовые команды/STT-шум — не факты; вход — untrusted, «не
    исполняй») → пишет через `memory/user-memory.writeUserMemory` (дедуп ≥0.93 + мост в профиль).
    fire-and-forget, кап 5/день, выкл `JARVIS_CONSOLIDATION=0` (в vitest.setup глушится). forget/stale —
    открытый TODO. (Б2) **skip-search на пустом сторе**: `episodic.hasEntries` (LIMIT 1 + process-кэш
    `known`, монотонно true) → `agent/index.ts` пропускает retrieval для нового юзера (мёртвая 350мс-
    гонка), свой короткий таймаут 150мс на голосе. Кешируемый блок фактов НЕ делался осознанно: цель
    «факты каждый ход» закрыта А1 (mergedFacts), 5-й cache-breakpoint конфликтовал бы с навыком (риск
    Д5) при копеечной выгоде. (Б3) **LIVE-РЕФРЕШ контекста** `agent/index.ts`: в ДЛИННОЙ задаче (≥3
    раундов) свежий `systemContext` (окна/вкладки/часы, обновляется client.system каждые 12с) впрыскивается
    ХВОСТОМ convo (`appendUserNote` + `shortTime`), ТОЛЬКО при изменении (не спамим) — БЕЗ пересборки
    system-блока (rolling-брейкпоинты целы, класс Д5 не задет); untrusted-обёртка; выкл
    `JARVIS_LIVE_CONTEXT_REFRESH=0`. (Б4 б-д) **RESUME-САНАЦИЯ**: (в) `session.sendAction` FAIL-FAST —
    сокет закрыт (resume-grace, сессия жива) → мгновенный `channel_down` (новый код в protocol/messages),
    не ждём таймаут → конец «задач-зомби» ($0.68/эпизод); (д) `channel_down` в петле НЕ эскалирует тир и
    не растит streak (мёртвый канал ≠ слабая модель — конец «Opus от транспорта»); (г) `waitForChannel`
    (окно `JARVIS_CHANNEL_WAIT_MS` деф 30с < resume-grace 120с) ждёт reconnect и повторяет раунд той же
    моделью, не вернулся → честный терминал `channelLost` (ok=false, кэш не пишется); (б)
    `manager.cancelOrphanedTasks` при провале resume ПРЕРЫВАЕТ задачи МЁРТВЫХ сессий (liveness через
    `registry.channelUp` — живой параллельный клиент не теряет работу). `channel_down` помечается ВО ВСЕХ
    путях sendAction (generic dispatch + hand-rolled: skills/code/browser_open/browser_act/browser_read/
    messaging/screen_capture через `channelDownResult`) — интеграционное ревью закрыло забытые call-sites.
    (Б6) **БЮДЖЕТ РАЗГОВОРА**: `Task.conversational` — разговорный ход (вопрос/комплимент) исключён из
    `active()`/`activeForUser()`/`recentTerminal()`/`isSubstantiveTask` (не всплывает в scope/«сделал?» —
    «да ты молодец» больше не §20-задача) + кап `HARD_STEP_CAP=3` (комплимент за $0.19 и 8 раундов срезан);
    recall НАМЕРЕННО оставлен (вопрос «как отправить X» тоже conversational, но выигрывает от навыка).
    **РЕВЬЮ волны Б (Opus, 4 CONFIRMED, все исправлены):** (#1) сон-цикл учитывает расход в SpendGuard
    (`ConsolidationDeps.spend`: check/recordUsage/finishTask — месячный потолок не обходится фоновым
    вызовом, как memory-reflect); (#2) Б3 не копит снимки — прежний Б3-снимок ВЫРЕЗАЕТСЯ
    (`pruneOldLiveSnapshots`, в контексте максимум один актуальный) + троттл `LIVE_REFRESH_EVERY=4`
    раунда (был квадратичный рост токенов на длинной GUI-задаче); (#3, correctness) `reassignActiveTasks`
    УБРАН (петля держит session в замыкании — перевес метки бесполезен, врал docstring) → честная
    `cancelOrphanedTasks`: при провале resume осиротевшие задачи старой (мёртвой) сессии ПРЕРЫВАЮТСЯ
    (иначе server-side задача писала ложный success в закрытый сокет); (#4, HIGH) исчерпание
    `HARD_STEP_CAP` без текстового ответа → честный терминал `capExhausted` (ok=false), НЕ дефолтное
    «Готово» (ложный успех на вопрос). **7 итераций адверс-ревью на Opus, находки сошлись 13→0** (все
    исправлены): реплики консолидации обёрнуты `<untrusted_content>` + код-фильтр `looksLikeDirective`
    (email/URL/пересылка/ключи не оседают в доверенном профиле — защита в глубину, не только промпт);
    Б3-снимки НЕ прунятся (ломало кеш Д5), а капятся `MAX_LIVE_REFRESHES=4` + троттл; `channel_down`
    помечается и в hand-rolled хендлерах (skills/code/browser через `channelDownResult`), не только в
    generic dispatch; `cancelOrphanedTasks` проверяет liveness сессии через registry (живой параллельный
    клиент не теряет работу); `capExhausted` считается по `loopIters` (не round, из-за continue) + отдаёт
    сохранённый `lastAnswer` на разговорном ходе (не ложное «не успел»); кап conversational 3→12 (не рвёт
    research-вопросы); «отмени» снимает и скрытую разговорную задачу (cancel до active-гейта). Финал: 7-й
    проход (4 файндера Opus) — 0 находок. Тесты: сервер 1191, +55 к волне Б.
  - **ИНТЕГРАЦИОННОЕ РЕВЬЮ ВСЕЙ СМЕНЫ (2026-07-12, 10 агентов Opus, дифф 973465a..HEAD = оба коммита):**
    финальный проход поверх покластерных — ловит МЕЖволновое и забытые sibling call-sites. Закрыто:
    (i) кап `input.type` на явном skill_execute сведён к ЕДИНОМУ `REPLAY_TYPE_MAX_CHARS`=150 (≈23с печати):
    прежний отдельный `REPLAY_STEP_TYPE_MAX_CHARS`=600 (77с) перебегал серверный потолок 130с → «два
    писателя»; бюджет реплея гейтит СТАРТ шага, не длительность, поэтому одиночный type обязан быть КОРОТКИМ
    по времени (2-й контрольный проход); (ii) `channel_down` в messaging (telegram/message/order) + `screen_capture` +
    `browser_read` — забытые call-sites (эскалация «от транспорта»); (iii) `synthTtsToBase64` (Telegram-
    voice) переиспользует `synthesizeToBuffer` — под yandex3 слал headerless-PCM как mp3 (битое голосовое);
    (iv) idempotency сон-цикла — атомарный `claimConsolidationRun` (TOCTOU loadProfile); (v) `capExhausted`-
    воскрешение гейтится `!blindMutatePending`; (vi) РЕГРЕССИЯ: cancel-ветка съедала «отмени напоминание»
    без задачи → перехват только при `hasAnyActive`; (vii) `looksLikeDirective` расширен (@/телефон/
    authority-директивы); (viii) `DRAIN_IDLE_MS` 2.5→11с (не рвёт медленную фразу). Тесты: сервер 1197 / клиент 187.
  - **АУДИТ ПРЕДСУЩЕСТВУЮЩЕГО ЯДРА (2026-07-12, 8 файндеров + 2 верификатора Opus по коду ВНЕ правок смены;
    9 CONFIRMED + 1 контрольный, все исправлены, +16 регресс-тестов):** свежий проход по voice/agent-loop/
    gateway/памяти/трейдингу/интеграциям/dispatch/клиент-актуаторам. Закрыто (нарушения законов честности/
    безопасности/ресурсов): [1] §7-эскалация МЕРТВА при схлопнутом `haiku==sonnet` — шаг haiku→sonnet видел ту
    же модель → форсил `currentTier="fable"` БЕЗ смены model → задача застревала на Sonnet, до Opus НЕ доходила;
    теперь идём по TIER_LADDER до первой ДРУГОЙ модели (пропуск схлопнутых ступеней); [2] verify-нудж/goal-check
    пушили пустой assistant-`content` → Anthropic 400 (как sibling — `.trim() || "…"`); [3] `STOP_STEMS` без
    «хватит/кончай/заканчивай» → авто-реплей запускного навыка на стоп-команде (гард полярности); [4] `resolveByPath`
    резолвил прогноз по ДО-входным свечам (фитиль до `createdAt` бил стоп/тейк) → фильтр `c.t>=createdAt`; [5]
    инвертированный стоп (не с той стороны входа) книжился как +1R ПОБЕДА (ложный успех трек-рекорда) → гард
    стороны → `resolveOne`; [7] `NaN>spendCap`===false → жёсткий spend-cap FAIL-OPEN на нечисловой сумме → fail-closed
    (`!Number.isFinite`→`blocked_cap`); [8] `skill_execute`=NEUTRAL → успешный GUI-реплей не взводил
    `anyMutateSucceeded` → masked-failure озвучивал ЛОЖНЫЙ «Не вышло» → теперь mutate (в BLIND_MUTATE не входит,
    своя checkExpect); [9] `ui_ground` не оборачивался в `<untrusted_content>` (name/value UIA — влияемый текст,
    M11) → добавлен; [10] гард опасного комбо работал ТОЛЬКО для `mode==="down"` → Alt(hold)+F4(**press**)
    синтезировал Alt+F4 мимо блок-листа; `heldKeys.clear()` на блоке/press ДЕСИНКал учёт (Alt забывался →
    второй заход обходил) → гард для `mode!=="up"`, учёт не чистится (снимается только явным up); [11] рекурсивное
    `fs_delete`/`fs_move` КАТАЛОГА сносило/релоцировало `node_modules`/`.env`/бинарь ВНУТРИ мимо leaf-гарда →
    `assertTreeWritable` (скан поддерева + предок бинаря `isAncestorOfSelf`), при исчерпании бюджета
    (200K) — FAIL-CLOSED отказ (не «чисто»). Env-выключателей нет — это исправления. Тесты: сервер 1205 / клиент 195.
  - **АУДИТ ЯДРА — 2-й ПРОХОД (2026-07-12, 8 файндеров + 2 верификатора Opus по НЕПОКРЫТЫМ подсистемам:
    крипто/MCP/extension/proactive/reminders/userbots/voice/клиент-актуаторы; 12 CONFIRMED — 9 исправлены+тесты,
    3 вынесены в `docs/AUDIT_2_OPEN_FINDINGS_2026-07-12.md`):** [1][2] MCP-зомби — гонка connectAll↔dispose
    (connectOne после dispose заселял живого сироту → `disposed`-флаг + kill свежего transport) и taskkill за
    зависшим последовательным `close()` (→ kill ВСЕХ по PID СРАЗУ, closes параллельно); [3] extension keep-alive
    interval тёк при throw `openTgTab` (→ внутрь try); [4] `ws.onerror` закрывал НОВЫЙ сокет (замыкание на
    мутабельную `ws` → захват `socket` + обнуление old.onerror); [5] `browser_tabs` отдавал title/host страницы
    как ДОВЕРЕННЫЙ текст (→ `<untrusted_content>`, M11); [6] ambient durable-`seen` ставился ДО доставки → срочный
    сигнал (офлайн-владелец + рестарт до flush) глох навсегда (→ mark ТОЛЬКО при реальной доставке + in-memory
    `queuedKeys` анти-дубль); [7] watch-checker кормил web_search/fetch в модель БЕЗ `<untrusted_content>` и без
    анти-инъекции в system → подделанная страница флипала вердикт `met:true` (→ обёртка + анти-инъекция); [8] дедуп
    отправки (`sentKeys`/`placedOrderKeys`) был вечным Set → блокировал ЛЕГИТИМНЫЙ повтор навсегда + тёк (→ окно
    `TtlCache`, `JARVIS_SEND_DEDUP_MS` деф 10мин); [11] browser-cdp play/pause/next возвращал `ok` без media →
    ложный успех (→ честная ошибка, как ветка click). Открыты (COM/дизайн, требуют живого Office/решения владельца):
    [9] дубль при доставлено-но-таймаут, [10] killOfficeTree бьёт все инстансы, [12] append_row затирает B1.
    Тесты: сервер 1210 / клиент 195, +5. Extension пересобран (нужен живой reload+смоук для [3][4]).
  - **ПАМЯТЬ+КОНТЕКСТ уровень А + Б4а/Б5 (2026-07-10, отчёт `docs/MEMORY_CONTEXT_REVIEW_2026-07-10.md`;
    диагноз: facts:0 навсегда — 3 структурных разрыва; контекст ПК замораживался; 39-мин STT-ход):**
    ПАМЯТЬ: (А1) баг спреда — retrieval-facts затирал профильные, теперь merge+dedup; (А2/А9) единый
    писатель `memory/user-memory.ts` (семантический дедуп ≥0.93 + мост fact/preference → профиль,
    кап 20 FIFO в `profile.addFact`); (А3) рефлекс-бэкстоп `agent/memory-reflect.ts` — реплика с
    маркером устойчивого факта («я всегда…», «мой брат…») → fire-and-forget рефлексия на дешёвом
    тире с узким набором [memory_write], суточный кап `JARVIS_MEMORY_REFLECT_CAP` (деф 8), выкл
    `JARVIS_MEMORY_REFLECT=0` (в vitest.setup глушится); persona v71 — позитивные триггеры записи
    («DO write unprompted…»); гигиена: 141 июньский STT-event помечен stale (обратимо). Проверено
    живьём: «я обычно работаю по ночам» → рефлекс записал, модель сама тоже вызвала memory_write,
    дедуп поймал дубль; profile.json facts наполнился впервые.
    КОНТЕКСТ ПК: (А4) `formatAmbient` — заголовки у ВСЕХ окон (группировка по процессу, кап 14,
    title 40); (А5) `WindowSnap.fullscreen` (rect≈bounds×scaleFactor) + presence-строка в снимке
    («Пользователь: за ПК/отошёл; полноэкранно: X») + оживлены сенсоры §9 (setActiveApp/setFullscreen
    из fg-окна — гейт проактива «не мешать в игре» работает); (А7) client.env TTL 6ч + Steam-игры из
    манифестов (`detectSteamGames`; живьём: «Dota 2» впервые в окружении); (А6) онбординг-кулдаун
    (`lastGreetedAt` в профиле, 6ч + «разговор шёл <1ч» + dev-сессии не здороваются — конец
    «приветствие ×7/день»); (А8) наблюдаемость: WARN 5 пустых снимков подряд, лог перехода
    пусто↔непусто, лог каждого записанного факта; (А10) деградация вкладок видима.
    ГОЛОС/УПРАВЛЕНИЕ: (Б4а) «отмени» адресуется по USERID (`tasks.cancelUser`) — после reconnect
    sessionId новый и отмена по sessionId плодила задачи-«отменить»; (Б5) `DEEPGRAM_KEYTERM=1` в
    .env (живьём: Results идут, страх «молчит» не подтвердился); wake near-miss в лог игнора +
    second-chance «Вы мне, сэр?» (первый токен lev≤4 + активная задача + кулдаун 2 мин, выкл
    `JARVIS_WAKE_SECOND_CHANCE=0`); EnergyVad: потолок «речи» ~20с (`maxSpeechFrames`) → форс
    speech_end + адаптивный порог под громкий фон (спад на тихих кадрах) — конец 39-минутных ходов.
  - **P0-фиксы «ложный успех/провал» (аудит логов + ревью, 2026-07-02):** (1) H2: аварийный стаб LLM
    (`stopReason==="stub"`) = провал хода — `tasks.fail`, ok=false, семантический кэш НЕ пишется (раньше
    «Связь прервалась» финалило задачу успехом и «заедало» из кэша после восстановления связи); (2) H3:
    чисто читающие инструменты (fs_read/list/search, telegram_read, knowledge_consult, market_*,
    tinkoff_portfolio, trade_winrate/predictions, monitor_list + mcp__* с читающим именем get/list/…)
    → `neutral` в `toolEffect` — «прочитал» не взводит anyMutateSucceeded; (3) H4: anti-runaway на
    байт-в-байт повторе успешного действия — нудж «сверь глазами/смени подход», при упорстве честный
    провал (раньше дефолт «Готово, сэр.» мимо verify); (4) goal-check срабатывает и ПОСЛЕ verify-раунда,
    если финал звучит как чистый запуск (`launchOnlyClaim`; живой случай «запусти поиск в доте» → «Дота
    запущена»: сверила глазами ПОДЦЕЛЬ); (5) ВОПРОС (`opts.conversational`) не гейтится masked-failure
    (mutate не ожидается; живой смоук: «2+2» + tool_load → «Не вышло») + нудж на СОДЕРЖАТЕЛЬНЫЙ финал
    при пустом тексте после инструментов (ответ, съеденный отброшенной преамбулой tool-раунда).
    Живой смоук текст-драйвером: «поиск матча в доте» → честное «задача не выполнена» вместо ложного done.
- `brain/router/index.ts` — **tier0** детерминированный путь ($0, без LLM): `WEB_SERVICES` (сайты),
  `LAUNCH_RE`/`looksLikeAppName` (запуск), `classifyTier`.
  - **ВОПРОС vs ДЕЙСТВИЕ (2026-07-01, корень «каждый вопрос воспринимает как задачу»):** `RouteDecision.
    conversational` решает СИНХРОННО-разговор vs ФОНОВАЯ §20-задача — НЕ тир (раньше любой sonnet/fable ход
    шёл в фон с дворецким-фреймингом). `looksLikeQuestion` (первое слово вопросительное / «?» / частица «ли»
    / зачин «расскажи/объясни/что такое») → conversational; `looksHardReasoning` → conversational ТОЛЬКО
    без `looksLikeAction` (глагол-действие: «проанализируй и СОСТАВЬ отчёт» = задача, не разговор). Простой
    вопрос → haiku (token-эконом), глубокое рассуждение → fable, но ОБА разговором. agent: фон только если
    `conversational !== true`. Вопрос ≠ задача: нет карточки/ack, ответ сразу стримом. Проверено живьём.
  - **LEAN-ПРОМПТ ДЛЯ SMALLTALK (§econ, 2026-07-21, лог-анализ: 27 тривиальных 0-раундовых ходов = 11% трат —
    холодная запись 33К-персоны на «привет» ~$0.2/ход из-за тир-свитча; за флагом `JARVIS_LEAN_SMALLTALK`, деф
    OFF → 0 регресс):** `RouteDecision.smalltalk=true` СТРОГО для ЧИСТО социальной реплики через ПОЗИТИВНЫЙ
    `router.isPureSocial` (снимает соц-паттерны `SMALL_TALK` giu-global; если ВЕСЬ остаток ∈ `SOCIAL_RESIDUAL_OK`
    — allowlist вежливости/связок — да). Любой СОДЕРЖАТЕЛЬНЫЙ токен (команда/вопрос/совет — даже с соц-префиксом
    «спасибо, включи музыку»/«круто, посоветуй фильм») → НЕ pureSocial → ПОЛНАЯ персона (как при флаге off).
    ⚠️ БЛОКЛИСТ императивов ПРИНЦИПИАЛЬНО неполон (ревью: добавь/проверь/сверни/врубай проскальзывали) — ТОЛЬКО
    позитивный allowlist безопасен; из filler убраны дейктики это/то/так (командные объекты: «могёшь это?»,
    сленг-«можешь» есть в SMALL_TALK). Агент (`runAgentLoop`): `lean = opts.smalltalk && env` → `buildSystemPrompt
    (…,{lean})` даёт `persona.LEAN_PERSONA_CORE` (~420 ток: жёсткие правила русский/идентичность-Джарвиса/тон-
    дворецкий/кириллица-иностранных/честность) + УРЕЗАННУЮ динамику (имя/время/тон/язык — без live-ПК/фактов/recall/
    каталога). Живой смоук LLM (флаг ON): «привет»→«Добрый вечер, сэр. Чем могу помочь?», «кто ты»→«Джарвис, ваш
    личный ассистент» — тон/идентичность/русский целы, вход 418 vs 33К ток (~$0.002 vs $0.2). 4 раунда адверс-
    ревью до нуля. Метка «НАМЕРЕНИЕ», не claim успеха; проскочивших команд нет (isPureSocial). ⚠️ Флаг деф-OFF —
    боевое включение после оценки владельцем на живых ходах.
  - **ТИР сложного ввода (P1.1, 2026-06-30):** `looksHardReasoning` (объясни/сравни/проанализируй/как
    лучше/стоит ли/план) → `fable`(Opus), не слабый Sonnet (корень «мало понимает на разборе»;
    эскалация §7 для рассуждения не наступала — у него нет проваленных инструментов). Теперь ещё и conversational (см. выше).
  - **tier0 СУЖЕН (P1.2):** `looksLikeAppName` теперь отвергает фразу-инструкцию с предлогом-связкой в
    многословии («X в поиске») или контент-сущ. («джазовый ПЛЕЙЛИСТ», «музыку») → уходит в LLM, не в
    слепой `app.launch`. Голое имя приложения ловится как раньше.
  - **МЕДИА/ГРОМКОСТЬ → tier0 (2026-06-23, фикс «перемотка гоняла полный Sonnet»):** `matchMediaIntent`
    (анкер `^…$` — команда = вся фраза, не ловит в середине) → интенты `media`(pause/play/next/prev) /
    `volume`(up/down/mute/set N) → `system.media`/`system.volume`. Исполняются СИНХРОННО без ack
    (одна фраза, мгновенно, $0) — `runTier0` `instant`-ветка, не плодит «Принял»+результат и не ждёт аренду.
    ⚠️ точную перемотку «на N секунд» НЕ берём (media-клавиши seek-по-секундам не умеют — нужен seek-актуатор,
    браузерный JS `video.currentTime`, отдельной задачей).
    - **ХВОСТЫ/ПРЕФИКСЫ/M5-кириллица (аудит 2026-07-02, «команды гоняли полный LLM»):** якорь всё ещё `^…$`,
      но матчер срезает хвостовую вежливость (`потише пожалуйста`, M10), берёт объект+локацию (`продолжи видео
      на ютубе`, `останови музыку` — pause с ОБЯЗАТЕЛЬНЫМ объектом, голое «выключи» НЕ медиа), инверсию
      `сними с паузы`/`паузы сними`→play, STT-словоформу `продолжу`, и короткий хвост после запятой (STT-шум
      `Videos, паузы сними`). M5: `следующ\p{L}*`/`включи следующ\p{L}*` вместо мёртвого `\w+` (не матчил
      кириллицу). Контент-задачи (`включи видео про котиков`, `включи музыку`) остаются в LLM. +тесты.
  - **Консьерж (§): ГОЛАЯ команда-сервис** («Джарвис, ютуб») → `matchQuickIntent` → интент `clarify`
    = МГНОВЕННЫЙ короткий вопрос (`QUICK_INTENTS`), без LLM (иначе лаг секунды даже на Sonnet-тире).
    Агент ставит `deps.pendingClarify`, следующая реплика резолвится `resolveClarifyAnswer` (тоже
    tier0) → действие. С ГЛАГОЛОМ «открой/запусти ютуб» — прямое открытие, как раньше (не вопрос).
    Расширять — строкой в `QUICK_INTENTS`/`QUICK_ALIASES`. **ВСЕ tier0-открытия** (консьерж И
    «открой/запусти X») идут с `browser.open{inDefault:true}` → НЕ CDP-инстанс.
  - **Открытие в браузере пользователя (мышь-сейф + без дублей вкладок):** `inDefault`-открытие в
    `runLocalIntent` сперва идёт через РАСШИРЕНИЕ (`deps.openOrFocus`→`ExtensionBridge.openOrFocus`→
    `tab.openOrFocus` в background.js): `chrome.tabs.query` видит открытые вкладки → есть вкладка
    сервиса → ФОКУС (не дубль), нет → новая — в ТВОЕЙ сессии/логине, без SendInput (мышь не трогаем).
    Расширение не подключено/ошибка → откат на `apps.launchApp` (shell-open в дефолтный браузер).
    ⚠️ Chrome 136+ ИГНОРИРУЕТ `--remote-debugging-port` на дефолтном профиле (анти-кража cookie) →
    CDP на реальном профиле НЕ работает; поэтому «просто открой» = расширение/shell, а CDP-управление
    (`browser.act`) — только на выделенном профиле. `browser-cdp` discover-таймаут снижен (env
    `JARVIS_CDP_TIMEOUT_MS`, деф 5с) — не висим 12с на заведомо мёртвом debug-порте.
- `brain/tools/dispatch.ts` — **ТОНКИЙ маршрутизатор tool-use** (376 строк, был god-object 1276 — разобран §ревью 2026-06-29):
  switch по имени → server-side хендлер ИЛИ ActionCommand → клиент. Общие хелперы — `dispatch-util.ts`
  (`ok`/`err`/`untrusted`/`numField`/`browserUrlBlocked`). Доменные хендлеры — `brain/tools/handlers/*.ts`:
  `market` (трейдинг), `browser` (вкладки/act/read через расширение + inBrowserTask), `messaging`
  (telegram/message/order + send-гарды confirm-once/cadence/идемпотентность), `info` (web/knowledge/memory-поиск),
  `skills` (HERMES list/execute/save/promote), `dynamic-tools` (саморасширение), `code` (`executeGuardedCode`),
  `reminders` (§9). ДОБАВИТЬ хендлер = файл в `handlers/` + case в switch. `ToolContext`/`ToolResult` — в dispatch.ts (импорт type-only в хендлеры, без цикла).
  - **БРАУЗЕР через расширение (§, ctx.ext=brain.extBridge):** `browser_open`/`browser_read`/`browser_act`
    идут в РЕАЛЬНЫЕ вкладки пользователя (его сессия/логин) через расширение, а НЕ в CDP-инстанс
    (мёртв на Chrome 136). `browser_open`→`tab.openOrFocus` (есть вкладка сервиса → ФОКУС, не дубль —
    лечит «плодит новые вкладки»); `browser_act`→`tab.act` (chrome.scripting: play/pause/next/click/
    type/scroll В вкладке — «взаимодействуй с уже открытой»); `browser_read`→`tab.read`. Расширение не
    подключено → откат: open=shell(inDefault), read/act=CDP(почти всегда ошибка). На странице не вышло
    (регион/нет элемента) → ЧЕСТНАЯ ошибка (§persona v22), не ложное «готово». Манифест `<all_urls>`.
    - **CANVAS ESCAPE-HATCH (P2.1, 2026-06-30):** мышь (`input_click`/`ui_ground`) во время браузерной
      задачи блокируется (не дёргаем курсор)... НО после ЧЕСТНОГО промаха `browser_act` (`markBrowserActMiss`
      на исключении/autoplay-гейте) открывается окно `canvasClickAllowed` (30с), где координатный
      `input_click` РАЗРЕШЁН — для canvas/WebGL/видео без DOM-кнопки (раньше «сдавался» на этом классе).
    - **ВЕБ-ГЛАЗА НА ПРОИЗВОЛЬНЫХ САЙТАХ (2026-07-14, корень «на Я.Музыке заебись, на других сайтах говно»):**
      Я.Музыка работала на хардкод-ветках инжектора + сид-навыке, а generic-сайт был слеп. Закрыто:
      (1) `browser_inspect`/`browser_tabs`/`browser_close` → ГОРЯЧИЕ (были COLD со стейл-комментом «CDP —
      редко», при этом persona звала inspect «main move on ANY site», а verify-нуджи требовали его в
      лестнице — cold-танец load→call = задокументированный промах, прецедент ui_*);
      (2) `browser_read` ЧЕСТНЫЙ: `selectorIntent` больше не игнорируется — расширение фильтрует строки
      по ключевым словам (контекст ±1, `filtered:false` → пометка «фильтр ничего не выделил») + разделы
      h1-h3 + ТЕКСТ IFRAME'ов (агрегация allFrames, служебные фреймы <40 симв отсекаются);
      (3) `browser_inspect` видит IFRAME (элементы с `frameId`, список `frames`) и SHADOW DOM (обход
      открытых root'ов, селектор `host >>> inner`); `browser_act` понимает `params.frameId` (явный таргет)
      и `>>>`-селекторы, а click/type/play/pause/seek при промахе top-фрейма САМИ прощупывают фреймы
      (`probeFrames` — только поиск, действие затем точно в найденный фрейм);
      (4) клик, вызвавший НАВИГАЦИЮ, больше не «frame was removed»-провал: SW-обёртка `runInPage` сверяет
      URL/status вкладки → честный `navigated` (observed на сервере); SPA-роут ловится по `location.href`
      (`withNav` в `robustClickMain`);
      (5) сид-навык `learned__generic-site-actions` — цикл «inspect → act{selector} → сверь исход» как
      процедурное знание для любого незнакомого сайта (when БЕЗ имён платформ — detectPlatforms не понимает
      отрицаний, иначе ложный platform-boost против профильных навыков).
      **АДВЕРС-РЕВЬЮ (2 прохода, воркфлоу 67+20 агентов Opus; 23 CONFIRMED в 1-м + 2 в фиксах — ВСЕ закрыты):**
      (а) ложный `navigated`-успех: `urlBefore` перечитывается ПОСЛЕ waitForTabReady; смерть контекста →
      navigated ТОЛЬКО для click/shake и с `uncertain:true` (сервер НЕ ставит `observed` — verify-долг цел);
      при явном frameId смерть = честный `frame_gone` (запрет слепого повтора), не вкладочный успех;
      type/enter/seek при смерти контекста — честный провал, не «переход». (б) probe рекламных iframe:
      `probeFrames` берёт МАКС по score среди НЕ-приватных фреймов (SSRF-фильтр `isPrivateHost`), text-порог
      сильный (≥80, точное/целое слово — префикс/подстрока убраны), media — видимый+крупный (video ≥160×90;
      audio играющий-не-muted ∨ видимый, `duration>0` убран — скрытый трекер не проходит); probe гейтится
      классом ошибки `not_found` (не `no_effect`/`frame_gone` — иначе двойной клик). (в) M11: page-controlled
      `navigated`/`frameUrl` — в `<untrusted_content>` с санитизацией `[<>]`; (г) filtered=OR по всем фреймам,
      сматчившие iframe в приоритете капа; (д) type+enter в ОДНОМ вызове = один документ (раздельный enter при
      фокусе вне документа — честный not_found). Тесты: сервер 1291, +браузерных кейсов; `isPrivateHost` — юнит-
      проверка (fc/fd публичные домены не ложно-приватны, IPv6-литералы ::1/fe80/fc/fd приватны).
      ⚠️ Открыто: jarvis SDK (мост code_run) намеренно НЕ пускает `browser.*` (BRIDGE_ALLOWED_KINDS —
      §14-гейты отправки в залогиненных сессиях); read-only browser в SDK — отдельное решение владельца.
      ⚠️ Живой смоук в реальном Chrome (reload расширения + не-Яндекс сайт с iframe/shadow) — за владельцем.
    - **AX-Ref РЕДИЗАЙН — АДРЕСАЦИЯ ПО ИДЕНТИЧНОСТИ (2026-07-15, `docs/WEB_ENV_REDESIGN_2026-07-15.md`; за
      флагом `JARVIS_BROWSER_REF`, деф OFF — нужен живой смоук owner'а):** корень «на Я.Музыке заебись, на
      других говно» = хардкод под Яндекс + generic-путь адресуется ХРУПКИМ text/nth-of-type-селектором,
      каждый act пере-резолвит путь → лишние раунды + тихий неверный клик на списках. Механизм:
      (1) **ref-реестр** в ISOLATED-world расширения (`globalThis.__jarvisRefs = {gen, map}`) — MV3 isolated
      world персистентен per (расширение,фрейм,документ), переживает `executeScript` и LLM-раунды, умирает на
      навигации → ref сам протухает. `inspectPageInPage(refMode)` минтит `ref=e<gen>_<n>` (frame-scoped SW-префикс
      `f<frameId>`), кладёт `Element` в map, старый gen отбрасывает; `tabAct`/`tabBatch` адресуют по ref:
      click-подобные — `stampRefIsolated`(nonce на 1 узел, uniqueness-checked)→MAIN `robustClickMain{nonce}`
      (React-first минует Swiper); type/seek/scroll/enter — `actByRefIsolated` (ISOLATED, нативный readback
      value). Устаревший gen/`!isConnected` → `ref_stale` (честный err, НЕ слепой хит; сервер `looksLikeRefStale`
      → не открывает canvas-хатч). Injected-функции self-contained (ax.js-модуль НЕ годится — executeScript
      сериализует func без замыканий; хелперы axName/stateOf/anchorFor ИНЛАЙН). (2) **СОСТОЯНИЕ в снимке** (всегда,
      аддитивно): `checked/selected/expanded/pressed/value/empty` + `accessibleName` (вопрос «тумблер вкл?» без
      screen_capture; пустое поле `empty:true` — серый текст = placeholder). (3) `selFor` — фикс МЁРТВОГО `break`
      (якорь nth-of-type к стабильному предку) + расширенный data-* (cy/e2e/automation-id). (4) **`browser_batch`**
      (`tabBatch`, COLD пока за флагом) — берст ≤12 шагов по ref одним вызовом (веб-аналог `input_batch`): пред-
      валидация ВСЕХ ref по фреймам ДО действий, стоп на первой ошибке, честное «k из n»; логин-форма 5-6→3 раунда.
      `BLIND_MUTATE`+mutate (error-voice), observed НЕ ставит (исход сверяется). (5) **Яндекс-хардкод ГЕЙЧЕН на
      `!refMode`** (`robustClickMain`/`pageActInPage` `location.href='music.yandex.ru'`) — при refMode знание
      приходит РЕЦЕПТОМ-хинтом, не хардкодом; refMode OFF → байт-в-байт как раньше (регресс-безопасно). (6)
      **РАНЖИРОВАННЫЙ observed** (`browser.ts`): STRONG (`value`/`checked` readback, `media.paused/currentTime`,
      достоверная навигация !uncertain) снимает verify-долг; WEAK (`changed:true` контейнер-диф, uncertain-nav)
      НЕ снимает; КОММИТ отправки (`type+enter`/`enter`/`submit`) НЕ снимается наблюдением поля (исход постинга
      сверяется). CDP-read фикс: обёрнут `untrusted()`. (7) **PER-HOST РЕЦЕПТЫ** `memory/site-recipes.ts` (стор
      по ТОЧНОМУ hostname — мимо шумного e5; recall/upsert/reinforce/demote+failCount-suppress, persist tmp→rename;
      seed = бывший Яндекс-хардкод как ДАННЫЕ + youtube; синглтон lazy env); recall инжектится ДОВЕРЕННЫМ хинтом в
      `browser_open` ТОЛЬКО под refMode. Сид-навыки `learned__generic-site-actions` v2 / `yandex-music-control` v3
      переписаны на ref/batch-цикл. Схемы `browser_inspect`/`browser_act`(params.ref)/`browser_batch` обновлены.
      **АДВЕРС-РЕВЬЮ (6 линз + верификаторы; 7 CONFIRMED — ВСЕ исправлены, верификаторы упали по лимиту сессии →
      адъюдицировано вручную):** (#1) коммит отправки `enter:"true"` СТРОКОЙ — расширение постит по truthy, но
      серверный `committing` (`===true`) не срабатывал → observed снимал долг на реальной отправке; теперь коммит
      по авторитетному `r.submitted===true`. (#2) seed-дубль `www.youtube.com` затирал полный `youtube.com` (оба
      нормализуются) — убран. (#4, HIGH) ref play/pause ставил observed даже при autoplay-гейте/чужом медиа —
      теперь rc.playing только при СОВПАДЕНИИ с намерением (play→playing/pause→paused), иначе честный
      autoplayBlocked (как mediaControlMain); MSE-плеер без media-элемента долг по playing не снимает. (#5) стейл
      `params.frameId` при top-ref резолвил ref в реестре ЧУЖОГО фрейма (gen не уникален между фреймами) — фрейм
      теперь ИСКЛЮЧИТЕЛЬНО из ref. (#6) page-controlled `value`-readback шёл в ДОВЕРЕННОЕ тело — вынесен в
      `<untrusted_content source="browser-act-observation">` с санитизацией (как navigated/frameUrl; password уже
      маскировался в readback — поймано до ревью). (#3/#7) сид-навыки учили ref/batch как основной путь при
      деф-OFF флаге — формулировки смягчены (ref/batch условны «если доступен», selector/text дефолт-дружественны).
      **Открыто (осознанно):** авто-запись рецепта из успешного прохода (upsert learned) — нужен distiller/
      loop-хук, API готов; SoM для canvas; промоут `browser_batch` в ГОРЯЧИЕ после включения флага. Тесты:
      сервер 1302 (+site-recipes +AX-Ref browser-кейсы вкл. регресс #1/#6), клиент 234; extension esbuild+node --check. ⚠️ **Живой
      смоук в реальном Chrome (flip JARVIS_BROWSER_REF=1 + reload расширения + сайт с iframe/shadow/списками/
      логин-формой; регресс-гейт на Я.Музыке ПЕРЕД дефолт-включением) — за владельцем; node --check ref-реестр/
      nonce-мост/batch не ловит.**
- **ЛЕНИВАЯ ЗАГРУЗКА инструментов (§15, фундамент MCP):** `tools[]` шлётся в префиксе ПЕРЕД `system` БЕЗ
  cache_control → любая мутация набора между ходами рушит весь prompt-кеш. Поэтому: ГОРЯЧИЕ инструменты
  (частые) всегда в наборе; ХОЛОДНЫЕ (`packages/tools COLD_TOOL_NAMES` — редкие + будущие MCP) НЕ шлются
  схемами, а одной строкой в кешируемом блоке `systemTools` (4-й cache-breakpoint в `anthropic.buildSystemBlocks`,
  после персоны). Модель подгружает схему `tool_load{names}` → `dispatch.toolLoad` кладёт в per-session
  `toolActivation` (Set, scoped на Session) → агент включает их схемы со следующего хода (дозапись в хвост
  tools = разовый кеш-промах, как rolling-breakpoint). `dispatch` исполняет инструмент по имени независимо
  от наличия схемы (фолбэк-безопасность). Это даёт арсенал в 100+ инструментов без раздувания контекста.
  **MCP-HOST РАБОТАЕТ (2026-06-19):** `brain/mcp/manager.ts` (McpManager: stdio через @modelcontextprotocol/sdk,
  неймспейс `mcp__<server>__<tool>`, callTool, dispose) + `brain/mcp/config.ts` (`mcp.json` в корне, `${ENV}`,
  Windows npx→npx.cmd, **uvx/uv→.exe** для Python-серверов). Boot: `server.ts` создаёт + `connectAll()`
  FIRE-AND-FORGET (не блокирует listen) + `mcp.dispose()` в close. `dispatch` роутит `mcp__`-tool →
  `ctx.mcp.callTool` (строго после KIND_BY_TOOL, не затеняет штатные; ошибка→честный err). MCP-tools =
  ХОЛОДНЫЕ (каталог §15, tool_load по имени). Проверено end-to-end: `think` (sequential-thinking, npx)
  подключается за ~2.3с. **Добавить сервер = строка в `mcp.json`** (есть закомментированные примеры
  git/fetch/time/github/postgres/playwright в `_disabled`). **HTTP-транспорт (ревью learn-coding-agent
  2026-07-15):** сервер с полем `url` в `mcp.json` (+опц. `headers` со статическим `Bearer ${ENV}`) идёт через
  `StreamableHTTPClientTransport` (удалённый/SaaS MCP) вместо stdio; `parseMcpConfig` (чистый, отдельно от IO)
  валидирует `^https?://` (иначе skip), резолвит `${ENV}` в url/headers. Без OAuth (тяжёл на headless single-user
  сервере) и без cross-app-access (enterprise-федерация, не наш профиль) — оба осознанно мимо; PAT/Bearer покрывает. ⚠️ **uvx-сервера (Python: git/fetch/time) на
  Windows гонятся за установку pywin32 в кэше uv при ПЕРВОМ конкурентном запуске (os error 32) → нужен
  ОДНОРАЗОВЫЙ ПОСЛЕДОВАТЕЛЬНЫЙ прогрев `uvx mcp-server-<x>` ДО первого boot** (см. `_uvx_note` в mcp.json);
  поэтому в активных `servers` держим только проверенно-подключающиеся (честность: не плодим мёртвые).
  Открыто: result-image из MCP сводится к тексту. (Зомби stdio-child на Windows — ЗАКРЫТО ревью 2026-07-04, L6:
  `manager.dispose()` держит ссылку на transport, берёт PID до `close()` и бьёт `taskkill /PID <pid> /T /F`;
  `gateway.close()` теперь `await mcp.dispose()` с таймаутом.)
- `brain/tools/input-kinds.ts` — какие команды берут **аренду ввода** §20 (GUI сериализуется).
- `brain/persona/` — `persona.md` (vХХ, тон/правила/возможности), `modes.ts` (режимы-маски butler/
  bold/storyteller/comedian), **`emotion.ts`** (команды «говори зло/радостно» §21).
- **§6B/B4-B5 (2026-06-21):** `db/crypto.ts` (AES-256-GCM, мастер-ключ env `CREDENTIALS_MASTER_KEY`→
  self-bootstrap keyfile) + `db/credentials.ts` (per-user шифр-ключи в user_credentials, `resolveUserKey`
  per-user→.env-фолбэк) + протокол `client.keys` (UI→сервер шифр.). `billing/index.ts SpendGuards` —
  реестр гвардов по userId (ожил persist usage_quota, траты per-tenant); вкладка «Оплата» биндит реальные
  `usage.info` (spent/cap/remaining). **COGS-телеметрия (2026-06-22):** `obs/pricing.ts` — ЕДИНЫЙ источник
  per-model тарифов (`costUsd(model,usage)`); РАНЬШЕ стоимость считалась в ДВУХ местах по разным и обоим
  неверным цифрам (SpendGuard по Haiku $1/$5, obs/metrics по старому Opus $15/$75, обе model-blind) → теперь
  по фактической модели хода. `obs/metrics snapshot` отдаёт `costByModel`; **`GET /cogs`** = окно телеметрии +
  расход per-user (`SpendGuards.allSnapshots()`) — дашборд юнит-экономики. Boot-WARN если все тиры схлопнуты
  в одну модель (footgun all-Opus: эскалация §7 мертва + дорогая ставка). Юнит-экономика → [project_jarvis_unit_econ].
  Миграции 0003 (auth_tokens) / 0004 (UNIQUE user_credentials). ДРЕМЛЮТ
  до hosted: strict-auth, provider hot-swap per-user ключей. Гайд: docs/UNIVERSALITY_MULTITENANT_PLAN.md.
- `brain/profile.ts` — персист профиля (имя, mode, **emotion**, facts, язык/контекст). **§6B/B3
  ПАРТИЦИЯ по userId:** `Map<userId,Profile>` + файл на юзера (DEV_USER→legacy `data/profile.json`,
  прочие→`data/profile/<id>.json`); `loadProfile(userId)` в handshake ДО makeSessionContext,
  get/setX берут userId. Так же по userId: resolution-memory (ключ `${userId}:…`), reminders
  (доставка только владельцу-userId, без any-speaker fallback), dynamic-tools (ключ `${userId}::name`).
- **Эмбеддинги (§1, 2026-06-23):** дефолт — ЛОКАЛЬНАЯ `integrations/local-embeddings.ts`
  (`LocalEmbeddingProvider`, multilingual-e5-small, 384d, CPU, без ключа/облака/GPU) вместо прежнего
  мусорного `HashEmbeddingProvider`. OpenAI — опт-ин при `OPENAI_API_KEY` (усечение `dimensions=384`).
  Канон dim=384 → столбец `episodic_memory.embedding=VECTOR(384)` (миграция `0005`). e5 требует
  префиксов: `embed(text,"query")` поиск / `embed(text,"passage")` запись (`episodic.ts`). Сбой загрузки
  модели → `null` (честная деградация, пустой retrieval), НЕ мусор. Проводка в `gateway/server.ts`.
  - **Грабли эмбеддера (живой тест 2026-06-23):** (1) `device`/`dtype` читаются В МОМЕНТ ВЫЗОВА getPipe, НЕ
    на module-load — `.env` грузится в index.ts ПОСЛЕ ESM-хойст-импортов. (2) На Windows нативный CPU-EP
    onnxruntime-node НЕ грузится («cannot run %1») → нужен `JARVIS_EMBED_DEVICE=dml` (DirectML, есть в
    зависимостях; цепочка фолбэков cpu→dml→webgpu в getPipe). На Linux-сервере дефолт `cpu` штатно работает.
    (3) `dtype=fp32` (model.onnx) — `q8`/model_quantized на hf-mirror 404. (4) 🔴 **sherpa-onnx-node
    (верификатор диктора) КОНФЛИКТУЕТ с onnxruntime-node (e5) в одном процессе на Windows** — оба тащат
    onnxruntime.dll, второй биндинг падает. **РЕШЕНО (2026-06-24): SPEAKER-САЙДКАР** — sherpa грузится в
    ОТДЕЛЬНОМ дочернем Node-процессе (`voice/speaker/sidecar-host.ts`), главный процесс держит лишь
    прокси (`verifier-sidecar.ts SidecarSpeakerVerifier`/`createSpeakerVerifierSidecar`), общение по
    stdio newline-JSON (`sidecar-protocol.ts`, PCM/байты base64). Так sherpa-onnxruntime изолирован от
    e5-onnxruntime → owner-gate работает ВМЕСТЕ с эмбеддингами. server.ts при `JARVIS_SPEAKER_GATE=1`
    зовёт сайдкар-фабрику (in-process — только `JARVIS_SPEAKER_SIDECAR=0`); любой сбой сайдкара →
    Mock (гейт выкл, boot цел). Проверено: smoke (реальный sherpa в child + identify round-trip) +
    boot gate=1 (`верификация диктора {ready:true, voices:1, mode:'sidecar'}`, без onnxruntime-краша).
    Гейт по умолчанию ВЫКЛ (`.env JARVIS_SPEAKER_GATE=0`) — включать осознанно у микрофона (калибровка).
- **Семантический кэш ответов (§15, `brain/response-cache.ts`, 2026-06-23):** `SemanticResponseCache` —
  пропуск вызова LLM, если на семантически близкий ФАКТИЧЕСКИЙ вопрос уже был чисто-вербальный ответ
  (эмбеддинг e5 + косинус, порог `JARVIS_RESPONSE_CACHE_MIN` деф 0.92). 🔴 БЕЗОПАСНОСТЬ: кэшируется ТОЛЬКО
  ход с `toolTrajectory.length===0` (ноль инструментов → нет побочных эффектов, реплей не врёт «сделано»)
  и только контекст-НЕзависимый запрос (`isCacheableQuery` денлист: ты/мы/сейчас/это/время/состояние →
  не кэшируем; токенизация, НЕ regex-`\b` — на кириллице не работает). Scoped по userId (мультитенант).
  lookup в `agent/index.ts handleUserText` ДО разветвления tier (хит = мгновенный вербальный ответ, $0),
  store в успешном терминале `runAgentLoop`. На hash-эмбеддере (null) кэш молчит (безопаснее матча по мусору).
- `memory/` — `episodic.ts` (pgvector RAG), `working.ts` (окно диалога), **`resolution-memory.ts`**
  (ОПЫТНАЯ ПАМЯТЬ резолва §скорость: `${channel}:foldName(query)`→{peerId,title}; remember на вериф.
  успехе, recall→fast-path, forget→self-heal; персист data/resolutions.json, переживает рестарт),
  **ГРУНДИНГ ФАКТАМИ (аудит контекста по статье «The Context Fails First», 2026-07-20; 2 раунда адверс-ревью
  до нуля):** корень «доверенный блок промпта копит НЕпроверенное/устаревшее» (два нижних измерения аудита —
  facts/memory). (1) **ПОРОГ авто-ретривала** `episodic.memoryMinScore()` дефолт 0→**0.82** — ОТКАЛИБРОВАН
  НА ЖИВОМ e5-small (не угадан): релевантный ~0.859, несвязанное ~0.75-0.79 (e5 сжимает косинусы вверх, 0.7-0.78
  протекали шумом). **EMBEDDER-AWARE** (F4): при `OPENAI_API_KEY` дефолт 0 (иная шкала косинусов — 0.82 убил бы
  весь ретривал); явный `JARVIS_MEMORY_MIN_SCORE` перекрывает. Явный `memory_search` порог НЕ применяет
  (передаёт 0, показывает score — модель судит сама). (2) **ПРОВЕНАНС** (`agent/index.ts` split +
  `persona/index.ts` рендер): эпизодический recall вынесен в ОТДЕЛЬНЫЙ ХЕДЖИРОВАННЫЙ блок «Возможно, всплыло из
  прошлых разговоров — сверься; не выдавай за факт», ОТДЕЛЬНО от курируемых фактов профиля (asserted «Известные
  факты»); дедуп recall против курируемых. Хедж несёт честность УНИВЕРСАЛЬНО (от порога не зависит → e5/OpenAI
  оба честны). (3) **ЧЕСТНОЕ ЗАБЫВАНИЕ** (раньше stale в рантайме НИКТО не выставлял → устаревший факт жил
  вечно): инструмент **`memory_forget`** (HOT, neutral) → `user-memory.forgetUserMemory`: `episodic.markStale`
  (stale=true, МЯГКОЕ/обратимое, порог `forgetMinScore()` e5 0.85 / OpenAI 0.6, cap 5) + `profile.removeFactsMatching`
  (ПОСЛОВНАЯ сверка — needle⊆fact по токенам ≥2, направление fact⊆needle УБРАНО против collateral «кот⊂скот»/
  компаунд; кап 5). Persona **v76** учит забывать устаревшее при поправке факта. Пороги калиброваны на живом e5
  (смоук), не на hash-моке. ⚠️ OpenAI-forget-порог НЕкалиброван вживую (нет OpenAI-данных) — консервативен, env-tune.
  **`skills.ts`** (HERMES
  самообучение навыками-процедурами; recall теперь **СЕМАНТИЧЕСКИЙ** (e5-косинус `recallSemantic`,
  порог `JARVIS_SKILL_SEMANTIC_MIN` деф 0.82) с лексическим фолбэком `matchLearnedSkill`; дедуп на сейве
  тоже семантический `findDuplicateSemantic` (порог 0.9, строже — лечит дубли дота/доте); кэш векторов
  триггеров `triggerVecCache`; эмбеддер передаётся в `createSkillProvider(embedder)` из server.ts.
  **ГИБРИД + PLATFORM-BOOST (2026-07-14, `memory/skill-recall.ts`, живой тест сидов):** e5-small ШУМНЫЙ
  (несвязанные навыки набирают 0.82+ у порога) и путал платформы («в дискорде» уходило к telegram-навыку).
  Гибридный ранг = косинус + лексический бонус (`LEXICAL_WEIGHT` деф 0.2, доля distinctive-токенов, капнута
  ≤1) + platform-boost (`detectPlatforms` по токену discord/telegram/vk/instagram/youtube/dota: та же
  платформа +`PLATFORM_BOOST` 0.1, чужая −`PLATFORM_PENALTY` 0.15). Бусты применяются ТОЛЬКО выше
  `RAW_COS_FLOOR` (деф 0.7) — иначе далёкий навык протаскивался через порог (ревью); штраф чужой платформы —
  всегда. Живьём: VK-запрос корректно тянет VK-навык (platformBoost), telegram не перехватывает Discord,
  регресса нет (Dota v5 выигрывает). ⚠️ **ПРЕДЕЛ: e5-small слишком слаб** для надёжного recall у power-user
  с плотной личной библиотекой (генерик-сиды тонут в шуме) — открыт трек «сильнее эмбеддер (e5-large/
  реранкер)». Все параметры env-tunable.
  **ГАРД ПОЛЯРНОСТИ (аудит лога 2026-07-03):** `memory/intent-polarity.ts` — recall (семантика И
  лексика) НЕ подсовывает навык противоположного намерения: строгий конфликт start↔stop по
  глагольным стемам («прекрати поиск у доти» ≠ навык «запустить поиск в доте», sim 0.856 — с
  авто-макросом реплей ЗАПУСТИЛ бы поиск на команду остановки); mixed/neutral не режем (решает
  модель). Заблокированный лучший кандидат логируется («подавлен гардом полярности»).
  **НАДЁЖНОСТЬ НАВЫКА (P2.3, 2026-06-30):** `fail_count` теперь ЖИВОЙ — `SkillProvider.recordOutcome`
  (agent-терминал зовёт для recall'нутого СВОЕГО навыка: провал +1, успех −1 через `adjustSkillFailCount`);
  recall (`isSuppressed`) перестаёт подсовывать навык при `failCount ≥ JARVIS_SKILL_FAIL_SUPPRESS`(деф 3) —
  Джарвис «учится на ошибках», не повторяет провальный приём; надёжный восстанавливается успехами.
  **ОБЩАЯ БИБЛИОТЕКА НАВЫКОВ (§мультитенант Фаза 1, 2026-06-23):** псевдо-юзер `SHARED_USER_ID`
  (нулевой UUID, ≠ DEV_USER `…0001`) хранит ОБЩИЕ навыки, видные ВСЕМ. `listSkillsMerged`/`getSkillMerged`
  сливают `свои ∪ общие` с дедупом по id — **частный перекрывает общий** (свой вариант главнее);
  provider list/get/recall/learnedCatalog идут через merged, а save-дедуп/delete — только свои (private-
  only, чтобы не мёржить в общий id). Инструмент **`skill_promote`** (`provider.promote`, COLD §15) —
  поднять СВОЙ выученный навык (owner-check, только learned-процедуры) копией под SHARED_USER_ID.
  Boot-seed (`seedSharedSkills` + `seed/shared-skills.ts`, идемпотентно по версии) засевает курируемый
  стартовый набор — чтобы новому юзеру не учить с нуля; `ensureUser(SHARED_
  USER_ID)` на boot для FK. **8 ФОКУСНЫХ навыков (2026-07-14):** веб-плеер (YouTube), telegram-send,
  yandex-music, discord-message, discord-voice, dota2-menu (только меню, не геймплей), social-read,
  social-send. Это ПРОЦЕДУРНОЕ ЗНАНИЕ (when+procedure проза, инжектится подсказкой; модель исполняет через
  jarvis SDK) — НЕ хардкод-шаги. Рельсы безопасности вшиты: Discord self-bot=бан→только UI, масс-
  автоматизация соцсетей=бан, публикация=confirm, сверка исхода. Навыки ФОКУСНЫЕ (одна capability на навык)
  для точного recall. `RecalledSkill.fromShared` → честная формулировка в `formatRecalledSkill`
  («приём из общей библиотеки» vs «твой прошлый»). Встроенные tools (telegram_send/browser_act/…) и так
  общие — shared-слой добавляет общие ПРОЦЕДУРЫ. Верифицировано: юнит (merge/override/promote/seed) +
  живой recall общего навыка чужим юзером (sim 0.864). ⚠️ кто может промоутить в hosted — ограничить
  admin (Фаза 3)), **`skill-slots.ts`** (§8 параметризация replay-навыка:
  `extractSlots`/`fillSlots` — переменные `{{slot}}` в шагах; `skillExecute` в dispatch заполняет их из
  `params` ДО исполнения, незаполненный слот → честная ошибка, не литерал в актуатор; `SkillInfo.slots`
  показывает нужные переменные в `skill_list`; литеральный навык без слотов не затронут),
  `brain/tools/dynamic.ts` (tool_create саморасширение).
  - **МУЛЬТИ-ДЕМО ДИСТИЛЛЯЦИЯ навыка (идея BrowserBC, §8, закрыт TODO «дистилляция процедуры»):** `skills.ts`
    копит ПОКАЗЫ одной capability (per-(user,skill) в `data/skills/_demos/<user>__<id>.json`, распознавание «той же»
    через существующий семантич. дедуп в `save`); чистая `distillProcedure(name,when,demos,fresh,distiller?)` — при ≥2
    показах И наличии дистиллятора зовёт его (сильный тир Opus в server.ts `skillDistiller`, env-выкл `JARVIS_SKILL_DISTILL=0`)
    → ОДНА обобщённая устойчивая процедура (общие шаги, частности в `{{slot}}`, грабли + шаг ВЕРИФИКАЦИИ), а не «как сделал
    последний раз». Срабатывает РЕДКО (повторное обучение) → расход мал; нет дистиллятора/упал → честный фолбэк на свежую.
    Исполнение/verify-loop НЕ тронуты (наша проверка исхода сильнее, чем «инжект markdown и надейся» у BrowserBC). +тесты.
  - **Tiered-исполнитель навыка (§8):** клиентский `apps/client/main/skill-runner/index.ts` гонит шаги
    ДЕТЕРМИНИРОВАННО ($0, без LLM); `EscalateFn` теперь возвращает карту params на `needs_llm` → раннер
    МЁРЖИТ её в шаг («модель заполняет переменные на повторе»); `needsLlm`-шаг без заполнения → ЧЕСТНЫЙ
    провал (не слепое исполнение, §честность). ⚠️ сам клиент↔сервер round-trip ещё no-op
    (`actuators/index.ts` не передаёт escalate) → пока needsLlm-шаги честно валятся; детерм. шаги (вкл.
    слоты, заполненные сервером в `skillExecute`) работают. Следующий срез: серверный handler escalate +
    маршрут escalate-вызова на ДЕШЁВЫЙ тир (тир теперь ЕСТЬ — слабый=Sonnet, §7-каскад жив с 2026-06-23).
  - **Токен-экономика навыка (§15):** recall'нутый навык инжектится в ОТДЕЛЬНЫЙ кешируемый
    системный блок `systemSkill` (`buildSystemPrompt.skillSuffix` → `anthropic.buildSystemBlocks`
    ставит свой cache_control ПОСЛЕ персоны, ДО динамики). На повторных ходах задачи навык читается
    из кеша (cache_read 0.1×), а не шлётся заново. Подтверждено живым тестом против Anthropic
    (`integrations/anthropic.live.test.ts`, gated `RUN_LIVE_LLM=1`). Открытые TODO из аудита:
    дистилляция процедуры, семантический recall (vector-колонка), удешевить self-learn (fable→sonnet).
- `brain/tasks/` — реестр долгих задач §20: `manager.ts` (TaskManager: lifecycle/active/list +
  `recentTerminal`/`toJSON`/`restore`/`setOnChange`), `task.ts` (типы + чистые `deriveTaskTitle`/
  `actionTitle`/**`formatRecentTasks`**/`isSubstantiveTask`), `scope.ts` (edit-vs-new + reject-маркеры
  «не то/вместо»→edit), `narrate.ts`, `control.ts` (стоп/пауза/отмена).
  - **ПРАВКА НА ХОДУ (§20, 2026-06-25):** `Task.steer{pending:[]}` (рантайм, как cancel) + `TaskManager.steer`;
    петля СЛИВАЕТ pending ПЕРЕД шагом и впрыскивает «⚡ПОПРАВКА…» в хвост convo. Перехват в `handleUserText`:
    активная задача + scope=edit → `tasks.steer`+ack «Принял, поправляю», БЕЗ второй петли (голос и текст).
    - **СТАТУС-ЗАПРОС vs ИНСТРУКЦИЯ-ПРАВКА (fix 2026-07-15, живой баг):** на «ты не сделал это» / «я не вижу,
      что делаешь» при активной задаче-ОЖИДАНИИ steer — no-op, а «Принял, поправляю» ВРАЛО (править нечего).
      `scope.looksLikeStatusQuery` (претензия «не сделал/не сработало» + вопрос о ходе «что там/готово/долго/
      делаешь») → steer впрыскивается (петля перепроверит), но ответ = ЧЕСТНЫЙ СТАТУС «Ещё занимаюсь этим, сэр —
      перепроверю и доложу», не «поправляю». Инструкция-правка («добавь/переделай/вместо») — прежнее «поправляю».
  - **ДУБЛЬ-ГЕЙТ (§20, аудит 2026-07-02):** `scope.ts isDuplicateGoal` (стем-Жаккар ≥0.75, ≥2 слов) — «new»-реплика,
    почти дословно совпадающая с целью УЖЕ идущей задачи (STT-вариация/нетерпеливый повтор: «продолжи/продолжу
    видео на ютубе» через 6с → две параллельные задачи, «остановил» ×2), не плодит вторую петлю: ack «Уже делаю, сэр».
  - **ТИХИЙ CANCEL (§20, аудит 2026-07-02):** ack отмены («Остановил.»/«Остановил все, сэр.») произносит ТОЛЬКО
    `gateway/task-control.ts` ОДИН раз на команду; терминал отменённой петли в `agent/index.ts` теперь `terminal("")`
    (молчит) — раньше КАЖДАЯ отменённая фоновая петля возвращала «Хорошо, остановил.» → на N задачах N голосов.
  - **ACK УПРАВЛЕНИЯ ОЗВУЧИВАЕТСЯ + ЛОГИРУЕТСЯ (аудит лога 2026-07-03):** `handleTaskControl` шлёт ack в ОБА
    канала (`ackControl`: transcript + `voice.speakQueued`) и пишет log.info на КАЖДУЮ команду (action/source
    voice|ui/taskId) — раньше UI-стоп был полностью немым и не оставлял НИ СТРОКИ в файловом логе («прекрати
    поиск у доти» умерла тишиной, разбор потребовал дедукции по коду). UI-статус — только текстом (панель видит).
  - **ОТЛОЖЕННЫЙ ACK долгой фоновой задачи (§20, аудит лога 2026-07-03):** задача без sink живёт дольше
    `JARVIS_TASK_ACK_MS` (деф 8000, 0=выкл) и ни одной фразы не прозвучало → ОДИН «Занимаюсь, сэр.» через
    speakResult. Cancel-safe ПО КОНСТРУКЦИИ (таймер читает task.cancel/state/spokeAny в момент срабатывания —
    ровно ретро ButlerAcks), clearTimeout в finally петли. «Тихий финал» не тронут: это не безусловный «Принял».
- `brain/knowledge/` — **слой ЭКСПЕРТНОСТИ (2026-06-25):** `index.ts` (`KnowledgeBase`) грузит доменные .md
  из `docs/` (реестр `DOMAIN_FILES`, путь через import.meta.url), разбивает по `## `, `consult(domain,query)`
  ищет релевантные разделы (ключевые слова, чисто/без эмбеддера). `DOMAIN_FILES` принимает `string|string[]` — под домен
  **`trading`** слиты **24 файла**, **371 раздел** дистиллята канона: базовые (risk/price-action/structure/indicators/regimes/
  psychology/quant/derivatives/macro/systems) + ГЛУБОКИЕ разборы методов (the-trading-process A→Z, support-resistance-levels,
  wyckoff-method, elder-triple-screen, brooks-price-action, smart-money-liquidity, supply-demand-zones, chart-patterns-classic,
  dow-theory-trend, market-profile-volume, market-wizards-lessons, entry-exit-execution, crypto-trading-specifics). Канон
  Murphy/Schwager/Van Tharp/Douglas/Elder/Wyckoff/Brooks/Edwards-Magee/Dalton/Bulkowski/ICT. Инструмент `knowledge_consult` (COLD), `untrusted()`.
  Персона v62: перед экспертной задачей — knowledge_consult + при нужде свежие web_*. Добавить домен = строка
  в DOMAIN_FILES + .md (универсально). Проводка как `market`.
  **ЧЕСТНЫЙ ПРОМАХ (аудит контекста 2026-07-20):** `ConsultResult += matched:boolean`. Раньше непустой запрос,
  не сматчивший НИ ОДНОГО раздела, молча возвращал `intro` с `found:true` → эксперт «свериался с литературой»,
  хотя релевантного раздела нет (мнимая консультация опаснее её отсутствия). Теперь промах → `matched:false`+
  пустой text; хендлер (`info.ts`) отвечает ЧЕСТНО «нет раздела под запрос X» + оглавление (не intro, не
  untrusted — это наш статус); пустой запрос (обзор) = `matched:true`+intro (не промах). `expert.ts` фолбэчит
  по `know.matched`. ⚠️ scoreSection всё ещё substring («тема»⊂«сис-тема» ложно матчит) — семантика открыта.
- `brain/trading/` — **ТОРГОВЫЙ контур (без денег, 2026-06-25):** `indicators.ts` (чистые SMA/EMA/RSI-Уайлдер/
  MACD/ATR), `market.ts` (`MarketDataProvider`: MOEX ISS + Binance, СПОТ и **ФЬЮЧЕРСЫ** `moex_fut` FORTS /
  `crypto_fut` fapi-перпы; чистые парсеры; честные ошибки), `index.ts` (`TradingService`: quote/candles/analyze
  + `inferMarket` + ПРОГНОЗЫ), `predictions.ts` (`PredictionStore`: record фиксирует вход+СТОП/ТЕЙК → `resolveDue`
  сверка по горизонту: со стопом → `resolveByPath` (path по свечам окна: стоп/тейк/время → R-мультипликатор), иначе →
  `resolveOne` (направление, backward-compat); `computeWinRate` += EXPECTANCY/R (`expectancyR`/`netExpectancyR`/`profitFactor`) —
  ГЛАВНОЕ табло «как профи», винрейт вторичен; персист data/trading/predictions.json), `orders.ts` (типы+`applyFill` — фундамент исполнения, ещё не подключён),
  `tinkoff.ts` (`TinkoffProvider`: Tinkoff Invest API REST — quote/candles/portfolio в РЕАЛЬНОМ времени;
  токен env `TINKOFF_INVEST_TOKEN` READ-ONLY, нет→выключен; парсеры чистые). market=`tinkoff` (делегирует
  MarketDataProvider) = «реальный тест»: точные данные API + `screen_capture` терминала (зрение) + trade_predict.
  Инструменты (COLD): `market_quote`/`market_candles`/`market_analyze`/`tinkoff_portfolio` + `trade_predict`/
  `trade_winrate`/`trade_predictions`. Проводка как `web`: BrainProviders.market→agentDeps→ctx;
  TradingService(provider, loadPredictionStore(), tinkoff). ДАННЫЕ+ПРОГНОЗЫ, НЕ совет.
  `backtest.ts` (историч. базовые ставки `conditionalBaseRate` по RSI + `multiFactorBaseRate` по связке
  RSI∧тренд∧MACD; индикаторы per-bar `rsiSeries/smaSeries/macdHistSeries`; tool `market_backtest`).
  `costs.ts` (`roundTripCostPct` круговая издержка; `Prediction.costPct` → `trade_winrate` net-после-комиссий +
  лидерборд по инструментам). `auto-predictor.ts` (`AutoPredictor`: фоновый цикл — прогноз ТОЛЬКО при историч.
  перевесе; `decideSetup` = дешёвый ПРЕД-СКРИН, env `JARVIS_AUTO_PREDICT=1`; набирает выборку за часы; старт/стоп в server.ts).
  **СЛОЙ 2 — `expert.ts` (`TradeExpert`): отобранный скрином сетап эскалируется LLM-эксперту (Opus/fable-тир). SYSTEM = ПОЛНЫЙ
  ПРОЦЕСС реального дискреционного трейдера (Wyckoff/Elder/Brooks/Market Wizards): биас старшего ТФ → значимый УРОВЕНЬ → РЕАКЦИЯ
  на уровне (отбой/ложный пробой/ретест, не касание) → контекст (BTC/импульс) → R:R≥2 → ТЕРПЕНИЕ (только A+, иначе пас). Сверяется
  с базой знаний (consult топ-4 раздела) + факты analyze → решение СО СТОПОМ/ТЕЙКОМ или ПАС; мусор/стоп-не-с-той-стороны/R:R<1.5 → честный пас (null).
  env `JARVIS_AUTO_PREDICT_EXPERT=1` (деф ВЫКЛ — автономные LLM-вызовы, бьёт РЕДКО по отобранным). Живьём: вход на сильном
  тренде R:R 4:1 со стопом за уровнем+ATR-буфер, пас на слабом откате.**
  **БИРЖА = ТОЛЬКО МАКС МОДЕЛЬ (Opus), БЕЗ ТИРОВ** (Антон: важна обдуманность; прямой роут ещё и быстрее
  эскалации): роутер `looksLikeTrading` (высокоточная лексика, кириллич. словоформы `[\p{L}]*`) → tier `fable`
  ДО smalltalk/ПОСЛЕ локального интента; страховка — `TRADING_TOOLS` в agent-loop эскалируют на fable. **ИСПОЛНЕНИЕ деньгами (брокер+риск-лимиты+confirm-гейт,
  бумажный режим) НЕ начато** — строится после трек-рекорда винрейта.
  - **«ОСОЗНАНИЕ задач» — переживает рестарт (фикс «Джарвис забывает, что сделал»):** реестр §20
    раньше жил в ОЗУ → перезапуск сервера (КАЖДЫЙ деплой) стирал «что я сделал», и на «сделал?» Джарвис
    не знал. Теперь `tasks/task-store.ts` (зеркало `working-store.ts`): снимок реестра в `data/tasks.json`
    (атомарно tmp→rename, дебаунс 300мс на onChange, **`flushTaskStores()` в gateway.close()** — иначе
    unref'нутый таймер не успел бы на graceful-shutdown). На restore НЕ-терминальная задача честно →
    `failed` («прервано перезапуском»), НЕ воскрешается как running (иначе соврал бы «всё ещё делаю»).
    Retention терминальных поднят 10мин→6ч (env `JARVIS_TASK_RETENTION_MS`, sweep клиенту ничего не шлёт).
  - **Инжект в контекст (§15-безопасно):** `agent/index.ts` зовёт `recentTerminal` (окно 6ч, ТОЛЬКО
    содержательные — `stepsDone>0`, иначе болтовня «привет» засоряла бы «сделал?») → `formatRecentTasks`
    → `UserContextSlot.recentTasks` → `renderDynamic` (НЕкешируемый хвост, кеш персоны не ломается).
- `proactive/` — `greeting.ts`; **`reminders/`** (РАБОЧЕЕ §9: store JSON + scheduler next-wakeup +
  set_reminder); **`watch/`** (РАБОЧЕЕ §долгие-задачи, 2026-07-01: durable МОНИТОРИНГ «следи за X→скажи
  когда Y»). `watch.ts`/`store.ts`(`data/watches.json`)/`service.ts`(recurring next-due `tickNow`, one-shot/
  continuous, антидребезг, лимиты min 30с/max 20, проактив через тот же speaker-registry, что напоминания)/
  `checker.ts`(РЕАЛЬНЫЙ: ограниченный LLM-цикл web_search/web_fetch+report на дешёвом тире — не выдумывает,
  нет данных=met:false). Инструменты COLD `watch_create`/`watch_cancel`/`watch_list` (имя `monitor_*` занято
  дисплеями!). Проводка как reminders (ctx.watch, BrainProviders.watch, registerSpeaker). Живьём: create→tick→
  web-чек→проактивная озвучка ✓; ⚠️ cancel в живом прогоне модель звала watch_create (follow-up, см.
  [project_jarvis_watch]).
  - **BROWSER-ПРЕДИКАТ + ОЖИДАНИЕ ТАЙМКОДА ВИДЕО (fix 2026-07-15, живой баг «жди 26:00→перемотай»):** задача
    «дождись, пока видео дойдёт до 26-й минуты, потом перемотай на 25-ю» не работала — агент клал OCR-предикат
    `{kind:"text","26:0"}`, а клиентский OCR-полл ВИСЕЛ >25с (captureScreen+сайдкар) → watch падал каждый тик
    («нет result за 25000ms»). Три фикса: (1) **`WaitCondition.kind:"browser"`** (protocol) — читает DOM-значение
    вкладки (`video.currentTime`/`duration`/`paused` или `selector.prop`) через РАСШИРЕНИЕ, а не OCR. Оценивается
    СЕРВЕРНО (`brain/tools/browser-condition.ts` `evalBrowserCondition`/`compareBrowserValue`): расширение висит
    на сервере (/ext), клиент до него не достаёт. `wait_for(browser)` — блокирующий поллинг в dispatch
    (`waitForBrowserTool`, потолок задачи idle tool-вызов не рвёт → «wait_for(browser)→browser_act seek» в одной
    петле); watch-предикат — `service.checkPredicate` browser-ветка через инжектнутый `setBrowserProbe` (проводка
    server.ts из extBridge). Расширение: интент `readMedia`/`getValue` в `pageActInPage` (bundle пересобран). (2)
    **OCR-полл БОЛЬШЕ НЕ ВИСНЕТ** (`sensors-cheap.ts`): `checkOnceCapped` гонит опрос наперегонки с per-poll капом
    (≤остаток бюджета, ≤4с) → зависший сенсор = честный met:false в срок, wait_for уважает свой timeout. (3) валидация
    browser-предиката в `handlers/watch.ts` (value обязателен, op из белого списка). Env-выключателей нет — это
    исправления. ⚠️ Watch только УВЕДОМЛЯЕТ (durable «потом СДЕЛАЙ действие» при срабатывании — открытый
    follow-up: нужен onFire-реэнтри агента; для ожиданий ≤~4 мин путь `wait_for(browser)`+действие в петле).
    Адверс-ревью (5 линз): 8 находок → 6 CONFIRMED, все исправлены (HIGH: `getValue`-утечка пароля→маскировка+кап;
    HIGH: блокирующий wait съедал бюджет петли→idle-ожидание вычтено как queue-wait; low/тесты). Живой смоук ✓.
  - **ЧТЕНИЕ ВРЕМЕНИ/СОСТОЯНИЯ ВИДЕО ИЗ DOM, НЕ ВИДИМОГО ТАЙМЕРА (fix 2026-07-15, живой баг «нужно двигать мышкой
    чтобы Джарвис видел время»):** на «сколько сейчас на видео» агент брал `screen_read_text`/OCR по ВИДИМОМУ
    таймеру, а сайты (YouTube и др.) прячут его при простое мыши → «не видит без движения курсором». Корень общий:
    Джарвис читал отрендеренный UI, а не DOM. Фикс: `browser_read` ВСЕГДА отдаёт `[Плеер: позиция из DOM]`
    (`video.currentTime`/`duration`/`paused`, доступны без видимого UI). Расширение: `readPageInPage` (для
    `browser_read`) и `media()` (для `readMedia`/`wait_for(browser)`/seek/play) выбирают ОСНОВНОЙ плеер = самый
    КРУПНЫЙ ВИДИМЫЙ (гейт видимости+размера: 1×1-трекеры/display:none/opacity долой, audio-ветка ДО display; площадь
    первична, длительность/звук — тай-брейкеры, играющий НЕ доминирует); `tabRead` межкадрово берёт крупнейший по
    площади (приватные хосты уже отфильтрованы `isPrivateHost`); сервер `browserRead` форматирует строку внутри
    untrusted. Персона v75: «время/состояние читай из DOM (`browser_read`/`inspect`), не `screen_read_text` по
    видимому UI — состояние в DOM, не в отрендеренном/наведённом; не проси „подвигать мышкой"». Живьём: «на какой
    секунде видео?» → `browser_read` → «Семь минут двадцать восемь секунд, на паузе. Мышь не трогал.» **АДВЕРС-РЕВЬЮ
    (2 прохода):** 1-й — CONFIRMED (честность): бонус 1e12 за «играющий» БЕЗ гейта видимости → играющая реклама/
    трекер/hero-луп при паузном ОСНОВНОМ видео озвучивался как факт; 2-й (аудит фикса) — тот же баг ОСТАВАЛСЯ в
    `media()` (брал ПЕРВЫЙ в DOM) + `<audio>` без controls отсекался. Все закрыты, живой регресс ✓. ⚠️ ОБОБЩЕНИЕ на
    не-медийный скрытый UI (тултипы/collapse) — читать DOM-состояние (частично AX-Ref за флагом `JARVIS_BROWSER_REF`);
    общий трек «DOM-состояние вместо видимого UI» открыт.
  - **`ambient/`** (РАБОЧЕЕ §проактив-всё, 2026-07-01: «Сэр, вам написал X», «не забудьте оплатить счёт»).
    Источнико-агностичный `engine.ts` (AmbientEngine: tick/дедуп(seen-store)/салиентность/проактив, 0 ток/тик) +
    источники `obligations.ts` (СЧЕТА по датам; инструменты ГОРЯЧИЕ obligation_*) + `telegram-source.ts`
    (непрочитанные из УЖЕ открытой вкладки через `telegram.unread`). BrainProviders.ambient/obligations. Конвейер
    счетов верифицирован живьём. ⚠️ Telegram: reload расширения + калибровка webK. 🔴 **ТЕКУЩАЯ ДАТА инжектится**
    (`persona/index.ts renderNow`) — без неё модель ставила прошлый год. watch_*/obligation_* — ГОРЯЧИЕ. [project_jarvis_ambient]
  - `scheduler.ts`/`triggers/`/`salience.ts`/`presence.ts` — СТАБЫ (не подключены).
- `voice/pipeline.ts` — машина состояний голоса (idle/listening/thinking/speaking), `speak`/
  **`speakQueued`** (проактивная речь, не перебивает юзера), barge-in, пофразный стриминг.
  - **BARGE-IN ПО УСТОЙЧИВОСТИ ВО ВРЕМЕНИ (fix 2026-07-15, живой баг «не озвучивает длинные фразы / не даёт
    прогноз погоды»; `apps/client/main/audio/index.ts`):** barge-in срабатывал по `BARGE_ONSET_FRAMES=2`
    кадрам (~20мс при 160 сэмплах/16кГц) → любой короткий спайк (реплика по ТВ, стук, ЭХО TTS сквозь
    несовершенный AEC) на 20мс рвал речь; чем длиннее фраза (прогноз погоды отдавался с реальным содержанием),
    тем вероятнее спайк её обрывал → пользователь не дослушивал = «не может дать прогноз». Теперь barge по
    ВРЕМЕНИ: `BARGE_SUSTAIN_MS` (env `JARVIS_BARGE_SUSTAIN_MS`, деф 200) непрерывного превышения порога +
    `BARGE_GAP_TOLERANCE_MS` 120 (короткий провал = микро-пауза между слогами речи НЕ сбрасывает отсчёт; сброс
    только на стойкой тишине — иначе живой barge с дырами не накопил бы sustain и владелец не смог бы перебить
    ВООБЩЕ). Поля `bargeVoicedSince`/`bargeBelowSince`; порог/грейс/рефрактер не трогали. +2 регресс-теста
    (спайк 80мс не рвёт; провал <120мс терпим→перебивает; провал >120мс сбрасывает). **АДВЕРС-РЕВЬЮ (3 линзы):**
    CONFIRMED — стейл-отсчёт переживал ЗАКРЫТИЕ окна (короткий голос владельца перед listening → реоткрытие
    хвостом → транзиент воскрешал баг). Фикс: `resetBargeSustain()` при закрытии окна во ВСЕХ путях
    (setServerState→listening, setPlaybackActive(false), mute, кадр в закрытом окне/tail-таймаут); +регресс-тест.
    ⚠️ Предел: сплошной громкий НЕ-речевой звук ≥sustain (громкая ТВ-фраза) всё ещё может ложно перебить —
    полностью решается только speaker-gate/loopback-AEC (открыты).
  - **«СТРОГИЙ WAKE В ШУМЕ» (акустика, 2026-07-14; 3 раунда адверс-ревью 7→3→0 находок):** зашумлённая
    обстановка (≥`JARVIS_NOISY_MIN_IGNORED`(3) НЕадресованных реплик за `JARVIS_NOISY_WINDOW_MS`(30с)
    при ЗАКРЫТОМ окне) → `noisyMode`: катящееся окно разговора ВЫКЛ (каждая команда требует «Джарвис»),
    second-chance подавлен. Выход — гистерезис ≤`JARVIS_NOISY_EXIT_IGNORED`(1); клампы кривого env:
    EXIT≤MIN-1, MIN≥1, окно≥1с (WARN в конструкторе — MIN=0 давал бы «вечный строгий wake в тишине»).
    Счётчик шума: ≤1 раз/ход (двойной проход gateWake: спекулятивный эндпоинт + поздний финал; сравнение
    `turnSeq > маркер` — запоздавший финал СТАРОГО хода не считается); near-miss lev≤4 (владелец
    докрикивается) и `isNoiseOnly`-междометия — НЕ шум. Реплики, ЗАБЛОКИРОВАННЫЕ строгим режимом в
    ОТКРЫТОМ окне, в счётчик не идут (иначе режим самоподдерживался бы владельцем), но метят `blockedAt`
    «сигнал маскирован» → выход по распаду при непустом blockedAt КОНСЕРВАТИВНЫЙ: окно закрывается
    (цена — одно «Джарвис»), лог честный «тишина не доказана» (чистый выход окно сохраняет; фон при
    закрытом окне снова наблюдаем → повторный вход жив). Лог игнора несёт `{noisy, inWindow}` (причина
    дропа видна из одной строки). Выключатель `JARVIS_STRICT_WAKE_IN_NOISE=0` (гасит и взведённый режим).
    ⚠️ Осознанный предел: ОТКРЫТОЕ окно текстом не защитить (владельца от фона не отличить) — закрывают
    sync-first и спикер-гейт (движок готов, `JARVIS_SPEAKER_GATE=0` — включать осознанно).
  - **§P0 ГЕЙТ АВТО-РЕПЛЕЯ + §P1 EARCON РАЗДУМЬЯ (2026-07-14, по форензике `docs/LOG_FORENSICS_2026-07-14.md`):**
    (P0) ~10 из 15 слепых авто-реплеев макросов запускались ЧУЖОЙ/разговорной речью (recall e5-small
    0.82–0.89: мат в Discord → «закрыть приложение», разговор о базе → 14-шаговый макрос). Гейт
    `brain/agent/replay-gate.ts` (`autoReplayBlocked` — причина в лог) режет СЛЕПОЙ реплей-прежде-петли
    (recall-подсказка в промпт и явный skill_execute не тронуты) по 5 условиям: гибридный
    `recallSim ≥ JARVIS_AUTO_REPLAY_MIN_SIM`(0.92) И сырой косинус `recallSimRaw ≥
    JARVIS_AUTO_REPLAY_MIN_RAW_COS`(0.84 — бусты лексики/платформы не заменяют семантику; лексический
    recall без косинуса реплей не получает), командный глагол в реплике, не-conversational, ЯВНОЕ
    «Джарвис» (новый контракт `UserTurnMeta.viaWake`: pipeline `gateWake` → `onUserTurn`/`onUserTurnStream`
    → router-ws → `handleUserText(meta)` → петля; реплика из катящегося окна жестов НЕ получает;
    ⚠️ новый вызов handleUserText без meta = «явное обращение» — не терять проводку), не мета-навык
    (про ЗАПИСЬ макросов: глагол записи+мета-слово; игровое «включи макрос фарма» — не мета). Поля
    `RecalledSkill.recallSim/recallSimRaw` ставит `recallSemantic`.
    (P1) 36% ходов молчали ~10с до первой реакции (earcon был только на приёмке ФОНОВОЙ задачи) →
    `pipeline.armThinkEarcon`: sync-first ход без звука дольше `JARVIS_THINK_EARCON_MS`(1800, 0=выкл) →
    один earcon-тик «услышал, думаю»; гард «речь пошла» = `PhraseSpeaker.speechStarted` (НЕ `active` —
    тот истинен с конструирования, тик был бы мёртв на стриминговом прод-пути; ревью HIGH), голосовой
    филлер замещает тик только на стриминговом пути.
  - **§P1-ТЁЗКИ + §P1-ОТПРАВКА + PLACEHOLDER-ЧЕСТНОСТЬ (2026-07-14, форензика + самоотчёт Джарвиса):**
    (тёзки, «не та Катя») `shared name-match.pickRecipient`: точное совпадение НЕ авто-шлёт при ≥2
    сильных кандидатах, чьё имя НАЧИНАЕТСЯ с запрошенного («Катя»+«Катя Любимая») → ask с
    `PickResult.reason:"namesakes"` — клиент (`jarvis-browser._openChat`) велит модели СПРОСИТЬ
    владельца (не выбирать по смыслу; "unclear" = прежнее «решает модель»); полное имя с точным чатом
    однозначно (регрессии нет). `telegram_send` принял `alias` («как владелец назвал») — на успехе
    опытная память пишет ОБА ключа (to+alias): после clarify «кате» ведёт к выбранному чату, повторный
    clarify перезаписывает (негативный сигнал), self-heal забывает оба.
    (отправка, «ушло в Клод») agent-петля: `composedPending` (input_type/ui_invoke setValue) + Enter/
    Ctrl+Enter = КОММИТ отправки — fused-observe его НЕ засчитывает сверкой (blindMutatePending
    взводится даже при observed) → терминал только после сверки ИСХОДА (поле пусто/текст в ленте).
    (placeholder, репорт самого Джарвиса «вижу серый текст — думаю, что ввёл») сайдкар
    `UiaGrounder.CollectText/CollectInteractive`: пустое поле ввода (Edit/Document) помечается
    `[ПУСТО]` в a11y-выжимке и `value:""` в ui_snapshot (Name пустого поля = серый placeholder!);
    Document/многострочный Edit БЕЗ ValuePattern читается фолбэком TextPattern (кап 400) — содержимое
    Блокнота и т.п. впервые видно выжимке. Легенды fused-observe (dispatch/skills) и описания
    ui_snapshot/screen_read_text/screen_capture объясняют семантику. Проверено живьём: пустой Блокнот →
    [ПУСТО], Блокнот с текстом → содержимое в выжимке; смоук сайдкара 11/11; сайдкар пересобран+published.
  - **«ТИХИЙ ФИНАЛ» (2026-06-23, фикс жалобы «×2-3 фразы на ВСЕХ ходах»):** содержательный ход
    (sonnet/fable) и tier0-в-фон БОЛЬШЕ НЕ произносят дворецкий ack. Корень был: ack («Принял, сэр.»)
    эмитился БЕЗУСЛОВНО + результат следом = 2 фразы на КАЖДОМ ходе. Теперь агент возвращает ПУСТУЮ
    реплику (`{voice:""}`) → ход завершается тихо, единственная фраза — сам результат через `speakResult`.
    Механика: `runAgentStreaming.done("")` (pipeline) не форсит «Готово.» и не шлёт пустой транскрипт/чат;
    `PhraseSpeaker.finish()` без фраз эмитит speak_done без speak_start → state.ts (thinking) вернёт цикл
    в listening+followup БЕЗ звука; `sendReply` (router-ws) тоже пропускает пустую реплику. Долгую
    многошаговую задачу подсвечивает ВИЗУАЛЬНАЯ панель прогресса (`task.status`), голосового филлера нет
    (как и прекеш-филлер «Секунду, сэр.» — выкл по умолчанию, та же причина «не отделываться фразой»).
    🗑️ **`brain/persona/acks.ts` (`ButlerAcks`) УДАЛЁН** — генератор форсированного ack ретирован вместе
    с фичей (если захочется короткий «принял» ТОЛЬКО на реально долгой задаче — делать ОТЛОЖЕННО и
    cancel-safe в пайплайне, не безусловным таймером в агенте: agent-layer-таймер не видит cancel-флаг
    задачи → стрелял лишним ack после «отмени», поймано адверсариал-ревью).
  - **§AEC эхо «видео/TTS→микрофон→лишние команды» — НАЧАТО, текстовый-фильтр ОТВЕРГНУТ (2026-06-23):**
    защиты, что УЖЕ есть: STT кормится ТОЛЬКО в `listening` (не в `speaking` → свой TTS не транскрибируется),
    browser `echoCancellation:true` (гасит СВОЙ TTS — reference = выход Chromium), barge-grace 250мс.
    Пробовал добавить ТЕКСТОВЫЙ self-echo фильтр (дропать транскрипт, совпавший с недавней речью Джарвиса) —
    **ОТКАЧЕН после адверсариал-ревью:** текст НЕ отличает эхо от НАМЕРЕННОГО повтора пользователя →
    глотал подтверждения уточнения («Создать напоминание купить хлеб?»→«создай напоминание купить хлеб») и
    диктовку/readback. Класс «слышит сам себя» решается АКУСТИЧЕСКИ, не по тексту. Открытые пути (нужен
    живой микрофон + выбор): (1) **loopback-AEC** — захват системного аудио (Electron desktopCapturer audio
    / WASAPI loopback) как reference → WebRTC APM/WASM-AEC в ворклете (гасит ЛЮБОЙ выход, вкл. чужое видео;
    см. [[project_jarvis_efficiency]] «лёгкий WASM на клиент»); (2) **оживить speaker-gate** (отклонять
    не-владельца — вкл. голоса из видео; сейчас выкл, биометрия сырая); (3) **Win32-сенсор «играет
    медиа/fullscreen»** (`client.context.fullscreen/micBusyByOtherApp` сейчас стаб) → при медиа требовать
    wake-word. ⚠️ browser-AEC ВНЕШНЕЕ медиа НЕ гасит (нет reference) — это и есть суть нерешённого.
- `integrations/` — STT `deepgram.ts` (облако, nova-3) / `whisper-stt.ts` (локал); **H14-фикс
  (2026-07-02, «глохнет после сетевого блипа»):** персистентный WS сбрасывает таймлайн
  (sentSec/processedSec/turnStartSec) на КАЖДОМ open, включая reconnect В ПРОСТОЕ — раньше стейл
  turnStartSec дропал все Results нового сокета («РЕЧЬ ПОТЕРЯНА» на каждом ходе до 120с тишины); TTS
  **`yandex-tts.ts`** (актив, голос filipp) / `elevenlabs.ts`; `tts-emotion.ts` (каталог ролей);
  `anthropic.ts` (Opus, стаб при сбое; **prompt-кеш §15:** `buildSystemBlocks` — экспортируемая
  чистая функция, ставит cache_control на [персона][навык] и оставляет [динамику] без кеша; живой
  тест экономии — `anthropic.live.test.ts`. **TTL=1h АКТИВЕН (`ANTHROPIC_CACHE_TTL=1h`, 2026-06-23):**
  extended-cache держит префикс тёплым в паузах разговора >5мин (5m истекал между репликами → холодная
  перезапись 25K-префикса); beta-заголовок ставится в `requestOptions`); `voice-providers.ts` (интерфейсы+Mock).
  - **ВЕБ-ИЗВЛЕЧЕНИЕ `web.ts` — ХАРДЕНИНГ (2026-07-21, план web-search, 9 раундов адверс-ревью до нуля; ~15
    реальных дефектов закрыто):** `web_fetch` тянет ПОДКОНТРОЛЬНЫЙ атакующему контент (LLM выбирает URL), а
    `extractReadable` был грубым `.replace(/<[^>]+>/g," ")`-strip'ом с **латентным ReDoS**: `[^>]+`/ленивые
    `[\s\S]*?</tag>` на 2MB `<`-плотного/незакрытого входа → O(n²) → синхронный парс вешал ВЕСЬ event-loop
    (голос+все сессии) на МИНУТЫ (сетевой `WEB_TIMEOUT_MS` не прерывает CPU-парс). Переписано на ЛИНЕЙНЫЙ
    (O(n), `indexOf`/charCode-скан + depth-парсинг) честный извлекатель: (1) `stripRawBlocks` — ЕДИНЫЙ
    левонаправленный проход убирает комментарии+script/style/noscript (кто раньше — тот целиком; закрыл асимметрию
    двухпроходности: `<!-- <script> -->` не цеплял реальный `</script>`, `<script>"<!--"` не ел до EOF); знает
    `-->`/`--!>`/abrupt `<!-->`; RCDATA `<title>`/`<textarea>` копируются с ЭКРАНИРОВАНным нутром (литеральный
    `</main>` внутри textarea не рвёт доминирующий блок); (2) основной блок = `<main>`/КОНКАТЕНАЦИЯ всех
    `<article>` (не «крупнейшая» — тред/лента целиком), но лишь если ДОМИНИРУЕТ (≥200 симв И ≥50% текста тела),
    иначе фолбэк на всё тело — молчаливый выброс = ложная полнота, ЗАПРЕЩЁН; depth-парсинг вложенности +
    `complete`-флаг (незакрытая статья → фолбэк, не частичный набор); open-теги `<tag(?=[\s/>])[^<>]*>`
    (`[^<>]*` стоп на `<` = линейно; lookahead ≠ `\b` → `<article-nav>`/`<style-guide>` не путаются с
    `<article>`/`<style>`); (3) `decodeEntities` — числовые `&#N;`/`&#xH;` (вкл. numeric-кириллицу) + именованные
    (RU-типографика «»—…); (4) `parseDuckDuckGoLite` (дефолтный keyless-поиск) тоже захаржен (`[^<>]`+ограниченный
    `[\s\S]{0,4000}?`). nav/footer/aside/svg НЕ режем блоком (опасно на битом HTML — цепляли чужой `</tag>`);
    фокус даёт извлечение `<main>`/`<article>` (оно их и так исключает). Вход ≤2MB (`MAX_HTML_BYTES`), выход
    `.slice(0,8000)`. ⚠️ ГЕВРИСТИКА, НЕ полный HTML5-парсер (jsdom осознанно НЕ берём — single-user; экзотика
    CDATA/PI/`<plaintext>` вне контракта). Каждый фикс — юнит-тест (27 в `web.test.ts`) + живой tsx-замер на
    продакшн-пути (интерпретаторный Irregexp, где V8 не JIT-ит — там и жил ReDoS).

## Клиент (`apps/client/main`)
- `transport/index.ts` — WS к серверу, backoff, resume.
- `actuators/index.ts` — `dispatch(ActionCommand)` → нужный актуатор; исключение → `error.runtime`.
- `actuators/`:
  - **`apps.ts` + `app-resolve.ts`** — запуск (умный резолвер: App Paths→Steam-манифесты→Пуск→PATH,
    честная проверка процесса), фокус (AppActivate, хрупкий), закрытие по процессу (self-exclusion).
  - `input.ts` — клавиатура/мышь/scancode (игры) через сайдкар.
  - `ground.ts` + `sidecar-client.ts` — UIA-грундинг (C# сайдкар).
  - `browser.ts` + `browser-cdp.ts` — видимый управляемый Chrome (CDP).
  - `jarvis-browser.ts` — НЕВИДИМЫЙ залогиненный браузер Джарвиса (web_open/read/act/login).
  - `code-runner.ts` — `code_run` (python/node/powershell, wall-clock таймаут).
    - **🚀 jarvis SDK (среда «1 раунд = вся задача», 2026-07-13, 6 раундов адверс. ревью до 0 находок):** для
      МНОГОШАГОВОЙ GUI/системной задачи модель пишет ОДИН python-скрипт `import jarvis` — он драйвит ТЕ ЖЕ
      актуаторы за ОДИН code_run вместо N слепых LLM-раундов «скриншот→клик». Механика: `actuators/act-bridge.ts`
      (loopback-HTTP мост на 127.0.0.1, `startActBridge(dispatch)` в `index.ts` на boot, стоп на quit) + `code-runner`
      кладёт `jarvis.py` (исходник — `actuators/jarvis-sdk-source.ts`, String.raw) в cwd раннера и ставит
      `JARVIS_ACT_URL/TOKEN` в env — **ТОЛЬКО для python** (node/powershell моста не видят). Скрипт `_call`-ит мост,
      мост → `dispatch(cmd)`. API: launch/focus/close/key/write/click/find→Element/invoke/snapshot/ocr/read_context/
      wait_for/wait_text/wait_window/windows/sleep; таймауты в СЕКУНДАХ; алиасы type/press/open. Провал → `JarvisError`
      (честный, не ложный успех). API-справка для модели — в описании `code_run` (`packages/tools`).
    - **БЕЗОПАСНОСТЬ моста:** `BRIDGE_ALLOWED_KINDS` — мост принимает ТОЛЬКО механический GUI/восприятие
      (app/window/input/ui/screen/wait/context); привилегированные каналы с §14-гейтом согласия
      (`telegram.send`/`message.send`/`order.place`/`jbrowser.*`) + `code.run`/`fs.*`/`office.*`/`system.*` → **403**
      (иначе prompt-injected скрипт слал бы от лица юзера в обход серверных confirm/cadence/idempotency и кредов).
      Токен per-boot в заголовке, bind loopback, тело ≤512KB.
    - **КООРДИНАТЫ SDK = АБСОЛЮТНЫЕ экранные DIP (единая система, закон честности «клик мимо с ok = ложный успех»):**
      `find()` кликает через handle→`ui.invoke` (снапшот) или screen-DIP (OCR полного кадра) — надёжно, без курсора;
      `ocr()` полного кадра конвертирует thumbnail-px строк → screen-DIP (`boundsX+x/scale`, mapping из `screen.ts`
      `ScreenShot.mapping`/`sensors-cheap.ts` `OcrOutcome.mapping`) + метит `space:"screen"`; `ocr(rect)` и `snapshot()`
      **выбрасывают** координатные поля (rect-строки — не в screen-DIP; снапшот-bbox — физ.px) → клик по ним честно
      падает, а не мимо; `click(x,y)` дефолт `space="screen"`.
  - `fs.ts` (CRUD + **`fs_edit`** точечная правка find/replace — для кодинга, дешевле перезаписи;
    через **`self-guard.ts`** — рельсы самомодификации: HARD-блок записи в node_modules/.env/
    запущенный бинарь + блок ЧТЕНИЯ .env §0), `system.ts` (питание/блокировка/медиа/громкость/буфер),
    `office.ts` (Word/Excel COM), `messaging.ts` (Telegram через расширение).
  - **`obs.ts`** — OBS Studio через **obs-websocket v5** (`obs_request` tool): ws→Hello→Identify(auth
    base64(sha256(base64(sha256(pw+salt))+challenge)), офиц. тест-вектор в `obs.test.ts`)→Request.
    Env `OBS_WEBSOCKET_HOST/PORT(4455)/PASSWORD`. ПРОГРАММНЫЙ путь вместо кликов: задать Twitch/ключ
    (`SetStreamServiceSettings` rtmp_custom) + прочитать обратно (`Get*`) = дешёвая верификация без
    скриншотов. ⚠️ раунд-трип к OBS вживую не прогнан (нет OBS в среде) — auth покрыт вектором.
    Правило персоны v21: «сначала API/CLI программы, GUI — последним».
  - **`screen.ts`** — ЗРЕНИЕ (§): `screen_capture` tool → Electron desktopCapturer снимает монитор →
    base64 PNG → `dispatch.lookAtScreen` отдаёт image-блоком в tool_result (модель ВИДИТ пиксели).
    ~1.5–2K токенов/взгляд, по необходимости. ⚠️ живой захват требует Electron — юнит-тест покрывает
    конвертацию (`dispatch-vision.test.ts`), сам захват проверять вживую.
    - **МУЛЬТИМОНИТОР-ЗРЕНИЕ (2026-07-14, эпизод «вруби демку в дискорде»: снимал курсорный монитор,
      не видел Дискорд на другом → ложное «свёрнут за хромом»):** дефолт (и `"active"`) = монитор
      ПЕРЕДНЕГО (foreground) окна, НЕ курсора (`foregroundDisplay` через сайдкар `window.list` →
      foreground-окно → его монитор; fallback курсор; выключатель `JARVIS_CAPTURE_FOREGROUND=0`). Это
      чинит focus→capture (window_focus окна на M1 → screen_capture снимает M1) и игры (fullscreen =
      foreground). Явно: `"cursor"` | `"primary"` | `"jarvis"` | `<индекс монитора>` (число ИЛИ
      ЧИСЛОВАЯ СТРОКА `"1"` — tool-путь всегда шлёт строкой, парсится). SCREEN-space rect снимается с
      монитора, СОДЕРЖАЩЕГО регион (не foreground/курсор — иначе fused-observe clickPoint на чужом
      мониторе клампился в 1px); IMAGE-space rect (прошлый снимок) — с дисплея lastMapping без лишнего
      foreground-вызова. `pickDisplay` async (сетевой вызов сайдкара на дефолтном пути).
    - **ОКНА ЗНАЮТ СВОЙ МОНИТОР (2026-07-14):** сайдкар `window.list`/`window.focus` отдают rect
      (`GetWindowRect`), клиент (`actuators/windows.ts`) обогащает `monitorIndex`/`monitor` через
      `monitors.displayForRect` — модель видит, НА КАКОМ мониторе окно, и не гадает «свёрнуто/не
      запущено» по одному кадру (window_focus readback тоже несёт монитор). Свёрнутое окно (off-screen
      rect ≤ -30000) → `monitor:"свёрнуто"` (не ложный «монитор N» от nearest-point промаха).
- `monitors.ts` (§6 мультимонитор): `MonitorManager` — рабочий монитор Джарвиса (персист
  `jarvis-monitors.json`). Tools `monitor_list`/`monitor_assign` (автономно) + ручная настройка в
  Настройках→Общее→Мониторы (IPC monitorList/monitorAssign/monitorInfo); `monitor_set` — врем. override.
  - **ОКНО реально позиционируется** (index.ts `placeWindow` через `monitors.setRelayout` +
    `windowPosition`): открывается на РАБОЧЕМ (по умолч. неосновном) мониторе; `monitor_set`(primary)
    = «выведи на основной» двигает окно на главный, (jarvis)/смена индекса — обратно/на новый.
- `settings-store.ts` — ЛОКАЛЬНЫЙ персист настроек (вкладки Общее/Ключи): язык/контекст → JSON
  `jarvis-settings.json`, API-ключи → ШИФРОВАННО через Electron `safeStorage` (нет шифрования ОС →
  ключ НЕ пишем, честно сообщаем `keysSkipped`). IPC `settingsGet`/`settingsSave` (invoke). Прифилл
  формы + честный фидбэк кнопки «Сохранить» в renderer.
  - **Язык/контекст ПОТРЕБЛЯЮТСЯ сервером:** при сохранении и на каждом коннекте main шлёт
    `client.settings`{language,context} → gateway `setLanguage`/`setContext` (profile.json) →
    `UserContextSlot.context/language` → системный промпт (`persona/index.ts renderDynamic`).
  - ⚠️ ГРАНИЦА: **API-ключи остаются ТОЛЬКО локально** (сервер их не получает, провайдеры берут
    ключи из `.env` один раз при boot — горячая подмена не сделана). Вкладка **«Оплата» — заглушка**
    (Pro/баланс статичны): реального тарифа/баланса в системе нет (§0 принцип 5 — без платёжных
    данных), есть лишь `SpendGuard` (лимит/потрачено) на сервере, клиенту не отправляется.
- `tier0/index.ts` — локальный $0-парсер dev-текста (renderer-ввод); громкость через SendKeys.
- `audio/` `vad/` `wakeword/` — захват, VAD, wake-слово «Джарвис» (текстовый MockWakeWord, не акустика).
- `sensors/system-profiler.ts` — что Джарвис знает о машине (detectApps по реальным exe) + **каталог
  автоматизации** `detectAutomationTools`/`TOOL_SPECS`: детектит CLI/локальные-API на PATH/exe
  (ffmpeg, tesseract, yt-dlp, git, gh, docker, ollama, blender, dotnet, psql, obs) и СООБЩАЕТ агенту
  КАК драйвить программно (через code_run / спец-инструмент). Расширять покрытие — строкой в TOOL_SPECS,
  НЕ новым актуатором (дедик-актуатор только для stateful-протоколов: OBS/Office). Правило персоны v21.

## Ключевые потоки
- **Ход (voice):** wake → STT(Deepgram) → `pipeline.onUserTurn` → `handleUserText` → перехваты/tier0/
  LLM-петля → tool-use → (server-side ИЛИ ActionCommand→клиент→актуатор→ActionResult) → ответ →
  verbalize → TTS(Yandex) → speak.chunk → клиент играет.
- **tool→ПК:** LLM эмитит `app_launch{app}` → dispatch → `ActionCommand{kind:app.launch}` →
  Session.sendAction → клиент `actuators/dispatch` → `apps.launchApp` → ActionResult назад.
- **Аренда ввода §20:** GUI-команды (input/app/browser/ui) сериализуются per-session `AsyncMutex`;
  не-GUI (fs/web/код) параллельно (Semaphore(3)).
- **Проактивная речь §9:** `ReminderScheduler` fire → `speakQueued` (тот же канал, что итоги фоновых
  задач) → speak.chunk. Клиент для проактива НЕ дорабатывался.

## Что Джарвис УМЕЕТ на ПК (и где гэпы) — по ревью 2026-06-18
| Операция | Инструмент | Статус |
|---|---|---|
| Запуск приложений/игр (Дота, Steam, Discord, Chrome) | `app_launch` (умный резолвер) | ✅ чинено: резолв из ОС + честный провал |
| Закрыть/фокус окна | `app_close`/`app_focus` | ✅ close надёжен; focus хрупкий (AppActivate) |
| Веб (поиск/открыть/читать/форма/логин) | `web_search`/`browser_*`/`web_*` | ✅ |
| Медиа/громкость | `system_media`/`system_volume` + tier0 SendKeys | ✅ |
| Файлы (CRUD/поиск) | `fs_*` | ✅ |
| Печать/хоткеи/клики/scancode (игры) | `input_*` | ✅ (UIA нужен сайдкар) |
| Telegram (отправка/чтение) | `telegram_send`/`telegram_read` (расширение) | ✅; прочие мессенджеры — через UI |
| Система (блок/сон/выкл/настройки) | `system_lock`/`system_power` | ✅ (выключение с предупреждением) |
| Мультимонитор (назначить рабочий экран) | `monitor_list`/`monitor_assign`/`monitor_set` + UI Настройки | ✅ автономно + вручную |
| Q&A / поиск в вебе | `web_search` (Brave→DDG keyless) / `web_fetch` | ✅ работает БЕЗ ключа (DuckDuckGo Lite фолбэк) |
| Текстовый чат + mute озвучки | вкладка «Чат» + кнопка mute в топбаре (§22) | ✅ печать→текст; mute=слышит+делает молча, ответ текстом |
| Word/Excel | `office_word`/`office_excel` (COM) | ✅ (фолбэк code_run если нет Office) |
| Напоминания/таймеры | `set_reminder`/`cancel`/`list` | ✅ новое (durable + проактивная озвучка) |
| Рынок: котировки/свечи/теханализ/ФЬЮЧИ | `market_quote`/`market_candles`/`market_analyze` (MOEX ISS+Binance, спот+фьючи) | ✅ read-only (данные не совет) |
| Прогнозы + EXPECTANCY/R | `trade_predict` (со стопом/тейком)/`trade_winrate` (матожидание в R + профит-фактор)/`trade_predictions`; LLM-эксперт в петле (`expert.ts`, env-гейт) | ✅ матожидание ≠ винрейт; path-сверка по R; денег не двигает |
| Исполнение сделок деньгами | брокер+лимиты+confirm | ⛔ не начато (после трек-рекорда винрейта) |
| Правка задачи на ходу | «нет не то / добавь ещё» → `Task.steer` впрыск в идущую петлю | ✅ не плодит вторую задачу |
| Эмоция голоса «говори зло/радостно» | `emotion.ts` + TtsOpts.emotion | ⚠️ работает, но filipp (тек.голос) умеет лишь strict; полная эмоция = голос jane |
| Произвольный лаунчер/экзотика | `code_run`/`web_search` | модель сама (по концепции) |

**Открытые гэпы (из 35-агентного ревью):** App Paths/Пуск/Steam-резолв есть. UWP-ЗАПУСК (Калькулятор и
т.п. через App Paths) ПОФИКШЕН вживую 2026-06-21 (стаб-лончер с ExitCode 0 = успех, не ложный провал);
остаются UWP только в `Get-StartApps` без App Paths (резолв не находит) и Epic (Spotify-Store → честный
провал → модель через code_run); verbose proactive-слой
(salience/presence/triggers) — стабы; persistent Deepgram WS (churn ~0.3с/ход); дубль-синтез очереди.

## Грабли (не наступать)
- TTS-провайдер = **Yandex** (`TTS_PROVIDER=yandex`), НЕ ElevenLabs. Аудио-теги `[warmly]` Yandex
  срезает. Эмоция Yandex — РОЛЬ голоса; **filipp эмоцию good/evil НЕ умеет** (проверено), только strict.
- **LLM SDK timeout** (`anthropic.ts`): общий потолок HTTP-вызова `JARVIS_LLM_TIMEOUT_MS` (деф 60с, был
  10с → тяжёлый кеш-промпт под нагрузкой давал `Request timed out`→стаб «связь прервалась»). Голос НЕ
  страдает: стрим защищён stall-watchdog `JARVIS_LLM_STREAM_STALL_MS` (25с, нет токенов → abort).
- **Напоминания идемпотентны** (`reminders/service.add`): идентичный текст+fireAt в окне
  `JARVIS_REMINDER_DEDUP_MS` (15с) → не создаём дубль (под rapid-fire ход наслаивался → задвоение).
- **ЖИВОЙ ТЕСТ КЛИЕНТСКИХ АКТУАТОРОВ (2026-06-21):** `POST /dev/action {kind,...}` шлёт РЕАЛЬНЫЙ
  ActionCommand в подключённый Electron-клиент и возвращает настоящий результат (текст-драйвер их
  фейкает). Клиент поднимать через **PowerShell** (`npx electron .`), НЕ Git Bash — bash даёт урезанный
  PATH без System32 → резолв app.launch падает (артефакт, не баг). Найдено+пофикшено вживую: (1)
  `app-resolve.ts` — UWP/Store-приложения (Калькулятор) РЕАЛЬНО запускались, но стаб-лончер (`calc.exe`)
  выходит мгновенно → ложный «не вышло»; теперь ExitCode 0 = успешный хэндофф (app.launch UWP работает);
  (2) `system.ts ps()` — буфер обмена бил кириллицу (PS писал в cp866, node читал utf8) → форс
  `[Console]::OutputEncoding=UTF8` (round-trip кириллицы/греческого ✓).
- Opus 4.8: НЕ слать temperature/top_p/top_k → HTTP 400. **thinking слать МОЖНО и НУЖНО, но ТОЛЬКО
  `{type:"adaptive"}`** (`thinkingArg` в anthropic.ts даёт Opus именно adaptive; `enabled`+budget на Opus →
  400, поэтому числовой эффорт коэрсится в adaptive). НЕ путать: «убрать thinking у Opus» вырубит
  рассуждение — это НЕ грабля, adaptive рабочий. **max_tokens — это ВЫВОД за ход,
  НЕ контекст** (контекст ~200K). Деф вывода env `JARVIS_MAX_OUTPUT_TOKENS` (8192, кламп [256,64000]).
  Обрыв (`stop_reason=max_tokens`) на не-голосовом ходе ДОКРУЧИВАЕТСЯ в agent-loop (continuation,
  кап `JARVIS_MAX_CONTINUATIONS`=6) — длинный код/реферат не отдаётся огрызком. Очень большой
  документ — писать в файл по частям (fs_write/office_word), а не одним ответом.
- PowerShell в актуаторах: цель через ENV (анти-инъекция). `where.exe` со `$ErrorActionPreference='Stop'`
  бросает на ненаходе — использовать `Get-Command`. Кириллица в PS-скриптах — через char-коды (ASCII).
- tier0 жадно ловит «запусти X» до LLM — следить, чтобы не глотал то, что должна решать модель.
- Эскалация тира §7 срабатывает ТОЛЬКО если целевой тир — другая модель (`nextModel !== model`).
  **Тиры РАЗВЕДЕНЫ (2026-06-23): слабый = Sonnet 4.6 (TIER1/TIER2), сильный = Opus 4.8 (TIER3).**
  Дефолт ходов → `sonnet`-тир (Sonnet); при полном провале раунда §7 эскалирует sonnet→fable=Opus
  (каскад ЖИВ). Haiku НЕ используем (забракована). `DEFAULT_MODELS` (shared) тоже без Haiku: дешёвый
  слот = Sonnet. Хочешь иной сплит — TIER1/2/3_MODEL в .env (boot-WARN ловит схлопывание в одну модель).
- НЕ закрывать сам Джарвис (electron/node) и критические процессы — `CRITICAL_PROCESSES` в apps.ts.

## Боли по форензике логов (2026-06-18, приоритет открытых)
1. **STT Deepgram WS churn** (HIGH): открытие/закрытие WS КАЖДЫЙ ход (~1600 open/close), 925 «ws error», 726 «ПУСТОЙ финал» (часть — реальная речь при peak>0.3) → главный корень «не слышит». Фикс: persistent WS + KeepAlive/Finalize вместо open-per-utterance.
2. **Resume** (БЫЛ сломан, ФИКС 2026-06-19): раньше `registry.remove` убивал сессию МГНОВЕННО на дисконнекте + `makeSessionContext` пересоздавал `WorkingMemory` на каждом коннекте → каждый обрыв WS терял историю («Джарвис забыл, о чём говорили»). ФИКС: (а) `registry.scheduleRemove` держит сессию **resume-окно 120с** (`RESUME_GRACE_MS`), reconnect отменяет удаление; (б) память диалога скоуплена на `Session.scoped("workingMemory")` — переживает rebind. Клиент уже шлёт `resumeSessionId` (transport:291). +4 теста registry.
   - **ПЕРСИСТ НА ДИСК (2026-06-19, корень «забывает»):** WS-resume не спасал от рестарта сервера (сессии в ОЗУ) — а я перезапускаю сервер на каждый деплой → контекст стирался КАЖДЫЙ раз (главная причина жалоб). ФИКС: `memory/working-store.ts` — `WorkingMemory` грузится/сохраняется в `data/memory/<userId>.json` (userId стабилен — захардкожен один dev-user `0000…0001`). `WorkingMemory.toJSON/restore/onChange` (дебаунс-сохранение 800мс, TTL 12ч, окно 20 реплик). Переживает рестарт СЕРВЕРА и КЛИЕНТА и обрыв WS. +5 тестов. Теперь мои рестарты НЕ стирают контекст.
   - **РЕЕСТР ЗАДАЧ ТОЖЕ ПЕРЕЖИВАЕТ РЕСТАРТ (2026-06-19, «забывает ЧТО сделал»):** §20-реестр был in-memory → на «сделал?» после деплоя Джарвис не знал. ФИКС: `brain/tasks/task-store.ts` (`data/tasks.json`, атомарно, `flushTaskStores()` на graceful-close) + инжект последних СОДЕРЖАТЕЛЬНЫХ терминальных задач в НЕкешируемый хвост промпта (`formatRecentTasks`, окно 6ч). Restore не-терминальной задачи → честный `failed` («прервано перезапуском»). Прогнан адверсариал-ревью (9 находок исправлено: болтовня stepsDone=0 не всплывает, flush на shutdown, parseInt retention, NaN-коэрс, дата прерванной = startedAt, чистка .tmp). +20 тестов (604 серв. зелёные). См. [project_jarvis_continuity](memory).
3. **Двойная обработка хода** (MEDIUM): interim+final коллизия → каждый ход логируется/обрабатывается дважды; dedup «дубль реплики» иногда съедает реальные команды. Обрабатывать только is_final/speech_final.
4. **Wake-word жёсткий** (MEDIUM): STT искажает «Джарвис»→«Джервис/Jarvia» → команды молча дропаются «без обращения». Нужен fuzzy-матч + Deepgram keyterm. **ЧАСТИЧНО ФИКС (живой лог 2026-06-18):** `wake.ts` теперь ловит «г»-ослышки (Гарвис/Гарвиз/Jarry's — Deepgram роняет «дж»→«г»; prefix-гард пускал только дж/ж/я/j → 218 зовов игнорилось). Добавлены «г»-варианты + «г» в fuzzy. Остаётся Deepgram keyterm.
   - **Ложный «Готово» по GUI (HIGH, живой лог):** на регион-блокнутой Я.Музыке (нет плеера) `input_click` возвращал ok («ткнул») → модель врала «Готово, заиграла», потом сама призналась. ФИКС: persona **v22** — «клик ≠ результат; проверь исход (screen_capture/browser_read) перед „готово“». **ПОДТВЕРЖДЕНО живым логом: честность сработала** — Джарвис сказал «за волну зацепиться не получилось… открыть видимым окном?» вместо вранья «готово».
   - **Браузер вслепую → через расширение (v24, воркфлоу `jarvis-music-stt-deepdive`):** `browser_open/read/act` в РЕАЛЬНЫХ вкладках (chrome.scripting), мышь не трогается, окно не выпрыгивает, латентность 60с→2с. Зафикшено по воркфлоу:
     - **hostOf падал на голом хосте** (`new URL("music.yandex.ru")` бросал → "" → дрейф в активную = Telegram). ФИКС: подставляем схему. Это был главный баг таргетинга под маской фикса.
     - **Селектор play промахивался:** боевая Я.Музыка — `aria-label="Воспроизведение"/"Пауза"` (не «воспроизвести»), `media()`=null (MSE). ФИКС `pageActInPage`: матч глобальной кнопки по aria-label (RU+EN), идемпотентность, **проверка исхода** (a/л флипается на «Пауза» если звук пошёл → не врём «играет»; иначе честно «нужен живой клик по вкладке», autoplay).
     - **tabId сквозь канал** (dispatch WeakMap `{url,tabId}` ← openOrFocus → tab.act/read): точное попадание + лечит гонку about:blank свежей вкладки. **Акт без open → честная ошибка** (не бьём в активную вслепую). Цель помним только на успехе того канала, которым открыли.
     - Медиаклавиша (`system_media`) — НЕ primary для play (уходит владельцу SMTC, может попасть в игру); только резерв.
   - **НЕ МЕШАТЬ активному пользователю (v26, по просьбе Антона):** физический ввод (`input.click/type/key` — SendInput, двигает курсор/шлёт нажатия) откладывается с ЧЕСТНЫМ отказом `denied:USER_BUSY`, если юзер СЕЙЧАС сам за компом. Сигнал — `powerMonitor.getSystemIdleTime()` (Electron, сек простоя); порог 4с. Тонкость: ввод САМОГО Джарвиса (SendInput) тоже сбрасывает idle → чистая логика `actuators/user-presence.ts isUserActive` отсекает свой ввод по `lastJarvisInputAt` (иначе мульти-шаг блокировал бы сам себя). Простаивает → действуем; активен → модель озвучивает «вижу, вы заняты, не хочу мешать» (persona §Поведение). Веб всё равно через `browser_act` (мышь не трогает вообще). Дотюн порога/толеранса — там же.
   - **Barge-in не работал** (живой лог: `barge_in` 0 раз за 17 сессий речи): браузерный `echoCancellation` при double-talk душит микрофон → rms не добивал порог 600. ФИКС [audio/index.ts]: порог 600→350 + диагностика «пик rms за сессию речи» (лог) для дотюна. Цепочка end-to-end цела (клиент→cancelTts→playback.stop).
   - **STT handshake-race** (короткая команда терялась: `close()` выбрасывал буфер до открытия WS → Deepgram ноль → «РЕЧЬ ПОТЕРЯНА»). ФИКС `deepgram.ts`: `close()` ждёт хендшейк (`waitForOpen`), если есть буфер.
   - **ОТКРЫТО — persistent Deepgram WS (боль #1):** воркфлоу дал детальный план (5 точек поломки: epoch вместо захваченного gen, beginTurn() отдельно от open, finalize() вместо close, watchdog KeepAlive). ОТДЕЛЬНОЙ сессией — рискованно, нужны тесты ДО свопа. Handshake-race выше — частичное смягчение.
5. **Латентность** (architectural): фраза→LLM = генерация Opus 2–13с (НЕ TTS, тот ~0.4с). Метрику «800мс» мерить как TTFB первого чанка; филлер-ack пока думает.
6. **ОПЕРАЦИОННОЕ:** логи показали сервер под `tsx watch` (56 рестартов) → EADDRINUSE + шторм ECONNREFUSED у клиента + частичные сборки (отсюда были transient `isEmotion`/`registerSpeaker` ReferenceError). ЗАПУСКАТЬ `npx tsx src/index.ts`, НЕ watch. Сервер теперь имеет crash-backstop (uncaughtException не валит процесс; handshake в try/catch).
> Многое из прежних логов УЖЕ исправлено в этой сессии (Дота/ложный успех, напоминания, keyless-поиск, гейт диктора, паузы-точки) — логи историчны.

## Кибербезопасность (волны 1–3, 2026-06-24) — см. docs/SECURITY.md + docs/SECURITY_AUDIT_2026-06-24.md
**Политика владельца:** мажордом для ОДНОГО юзера с ПОЛНЫМ управлением Windows. `code.run` НАМЕРЕННО
мощный (НЕ песочница) — защита не в урезании мощи, а в том, что ею управляет только владелец.
- **Граница данные/инструкции (гл. вектор, анти-prompt-injection):** недоверенный вывод инструментов
  (`web_*`/`browser_read`/`browser_inspect`) оборачивается в `<untrusted_content source="…">`
  (`dispatch.untrusted()`), `screen_capture` помечен «текст = данные», persona **v44** запрещает
  исполнять инструкции из читаемого текста. Это замена песочнице code.run. **Ревью 2026-07-04 (M11):**
  живой контекст ПК (заголовки окон/имена процессов из `client.system`) — тоже влияемые атакующим данные →
  оборачиваются тем же `<untrusted_content source="live-system">` при сборке промпта (`persona/index.ts`);
  клиент (`sensors/system-snapshot.ts`) шлёт заголовки СЫРЫМИ, тег навешивает сервер.
  **Ревью 2026-07-20 (аудит контекста, F7):** ВЫВОД MCP-ИНСТРУМЕНТОВ (`dispatch.ts` MCP-путь) — тоже внешний
  недоверенный текст (страницы/issues/PR/файлы через fetch/github/… MCP) — был ЕДИНСТВЕННЫМ read-каналом без
  обёртки. Теперь ОБЕ ветки: успех → `untrusted("mcp:<server>", …)`, ошибка → `untrustedError(…)` (тело err
  relay-MCP тоже внешнее; **isError:true сохранён** — провал не маскируется успехом). DRY: общий `wrapUntrusted`
  в `dispatch-util` под `untrusted`/`untrustedError`.
  **SSRF ДЛЯ MCP (глобальный план 2026-07-21, P0 «MCP-контракт», предусловие Фазы A relay-серверов):** MCP-ветка
  раньше минула URL-гард → prompt-injected url-аргумент увёл бы `mcp__fetch__fetch` на внутренний адрес/
  метаданные/`file:`. Теперь ДО `callTool` — `findBlockedMcpUrl(input)` (`dispatch-util`): рекурсивно (глубина ≤4)
  ищет URL-подобное значение, отвергаемое `browserUrlBlocked`. URL-подобное = ЗАЯКОРЕННАЯ `scheme://` ИЛИ опасная
  схема (`file:`/`data:`/`chrome:`/…) ИЛИ ГОЛЫЙ хост/IP-литерал (`looksLikeBareHost`: dotted-IPv4/`[IPv6]`/
  `localhost`/`*.internal`). Адверс-ревью закрыл (а) BYPASS голого хоста (метадата-цель `169.254.169.254` без
  схемы минула бы `.includes("://")`) и (б) FALSE-POSITIVE — `.includes("://")` блокировал весь вызов content-MCP
  (`think.thought` со ссылкой в тексте); второй гейт `browserUrlBlocked` не трогает ПУБЛИЧНЫЕ (8.8.8.8/версия
  1.2.3.4), Windows-путь «C:\…» не URL-подобен. ⚠️ строковый слой не ловит DNS-rebinding/redirect (defense-in-depth).
  **§14 CONFIRM + ПРОБРОС IMAGE (MCP-контракт, срез 2):** (confirm) mcp.json декларирует `confirm: true`/массив
  bare-имён (`config.parseConfirm`, `.filter` — один мусорный элемент НЕ роняет всю декларацию, fail-open закрыт);
  `manager.requiresConfirm(name)` резолвит; MCP-ветка dispatch ПОСЛЕ SSRF ДО callTool гейтит через `ctx.confirm`
  (нет канала → fail-closed err; сводка показывает АРГУМЕНТЫ — осознанный approve). (image) `manager.callTool`
  раньше схлопывал image в `[image]`; теперь `normalizeMcpImages` (чистая, экспорт) — allowlist Anthropic
  (jpeg/png/gif/webp; svg/bmp/пустой-после-data-URI/`>5MB` → ДРОП, иначе HTTP 400 на ВЕСЬ ход), срез data-URI-
  префикса, кап 4, честная нота о дропнутых; dispatch собирает vision-tool_result (untrusted-текст + image-блоки).
  Открыто (последний кусок контракта): декларативный `toolEffect` в mcp.json. Далее — Фаза A (активация
  read-only relay-серверов OBS/Tavily/Fetch/Git из `_disabled`).
- **Денилист секретов** (`apps/client/.../self-guard.isSecretPath`): `.env`/`id_rsa`/`*.pem`/`*.key`/
  `credentials-master.key`/`Login Data`/`.ssh`/`.aws` — блок read+write+delete+move+search в `fs_*`.
  **Ревью 2026-07-04:** C2 — денилист ловит и САМУ папку `.ssh`/`.aws`/`.gnupg` (regex `(?:[\\/]|$)`, не
  только файлы внутри); H3 — `fs_search` фильтрует секреты и в ветке поиска ПО ИМЕНИ (не только по контенту);
  H1 — `office_word`/`office_excel` тоже проходят `assertReadable`/`assertWritable` до COM.
- **Сеть fail-closed:** `bind.ts` — не-loopback только при `JARVIS_ALLOW_REMOTE` И `JARVIS_AUTH_STRICT`
  (иначе → 127.0.0.1). HTTP `/dev/*`+`/ext/*` (исполняли действия БЕЗ auth) — за `JARVIS_DEV_HTTP=1`
  (деф ВЫКЛ → 404) + loopback-only + опц. `JARVIS_DEV_TOKEN`. `/ext` WS — Origin-чек `chrome-extension://`.
  `browser_*` — SSRF-гард (приватная сеть/loopback/метаданные/`file:`/`chrome:` блок, `browserUrlBlocked`).
  **Ревью 2026-07-04 (C1):** `browserUrlBlocked` больше НЕ fail-open на голом хосте без схемы (`new URL`
  бросал → нормализуем `https://` и прогоняем те же проверки; непарсящийся → блок). `web_login` добавлен
  в `URL_NAV_TOOLS`; `jarvis-browser`/`browser-cdp` санитайзят url (`safeBrowserUrl`: http/https + reject
  `-`-leading argv → анти Chrome-flag-инъекция, H2/L9). `input_key` — учёт удерживаемых модификаторов между
  `down`/`up` (Alt+F4 двумя вызовами блокируется, H4).
- **Least-privilege:** MCP-дети — env-allowlist (`manager.baseChildEnv`), не весь `process.env`; версии
  MCP в `mcp.json` ЗАПИНЕНЫ (H16, не `@latest`).
- **НЕ реализовано осознанно** (политика «полное управление Windows»): сэндбокс code.run (Job Object/
  CLM/firewall/CWD-jail), confirm на каждый PowerShell. **Инфра/отложено:** TLS/wss (reverse-proxy),
  overwrite-confirm fs, admin-гейт `skill_promote` (hosted).

## Где искать
- Новый инструмент → `packages/tools/src/index.ts` (схема) + `brain/tools/dispatch.ts` (хендлер) +
  (если ActionCommand) `packages/protocol/actions.ts` + `apps/client/main/actuators/`.
- Поведение/тон → `brain/persona/persona.md` (бампать version при правке тона).
- Что было сделано/решено → авто-память `MEMORY.md` (project_jarvis_*), `docs/STATUS.md`, `docs/NEXT_SESSION.md`.
