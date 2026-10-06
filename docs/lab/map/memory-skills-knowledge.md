# Карта: memory-skills-knowledge (память, навыки, рецепты, знания, профиль, согласия)

Область: `apps/server/src/memory/*`, `seed/*`, `brain/knowledge/*`, `brain/profile.ts`, `brain/consent.ts`, консолидация
(`proactive/consolidation*.ts`), потребители в петле (`brain/agent/loop/retrieval.ts`, `prompt.ts`, `finalize.ts`,
`self-learn.ts`, `agent/memory-reflect.ts`) и хендлеры (`brain/tools/dispatch.ts`, `handlers/{info,skills}.ts`).
Прочитано, не запускалось. Все пути от `apps/server/src/`, если не сказано иное.

## 1. Как работает

### 1.1 Хранилища (что, где, срок жизни)

| Хранилище | Где | Носитель | Ключ/партиция | Срок/кап |
|---|---|---|---|---|
| Эпизодика (факты/предпочтения/события) | `memory/episodic.ts` | Postgres `episodic_memory` + pgvector (`PgVectorEpisodicMemory:161`), без DATABASE_URL — `InMemoryEpisodicMemory:372` (процесс) | `user_id` | вечно; мягко: `stale` (владелец), `invalid_at` (система, миграция 0006) |
| Навыки (реплей-демо + выученные `learned__*`) | `memory/skills.ts` | Postgres `skills` + файлы `data/skills/*.md` (`writeSkillFile:130`) + фолбэк `memSkills` (процесс, :49) | `(id,user_id)`; общая библиотека `SHARED_USER_ID` (:47) | версия++ на пересейв; `fail_count` |
| Демо-показы для дистилляции | `skills.ts` `readDemos/writeDemos` | файлы `data/skills` | user+id | — |
| Карантин навыков | `skills.ts:153` | диск | user | — |
| Рабочая память (окно реплик + стек сущностей) | `memory/working.ts` (кольцо 40 реплик, 12 сущностей) | процесс; персист `working-store.ts` -> `data/memory/<user>.json` | user | TTL 12 ч (:16), дебаунс 120 мс, flush на close |
| Профиль (имя, режим, язык, `facts[]`, метки `lastGreeted/Briefed/Consolidated`) | `brain/profile.ts` | `data/profile.json` (DEV_USER) / `data/profile/<id>.json`; sidecar провенанса; архив вытесненных `evicted-<id>.jsonl` | user | кап фактов 50 (env `JARVIS_PROFILE_FACTS_MAX`, [10..500]) FIFO -> в архив |
| Согласия на отправку | `brain/consent.ts` | `data/consent.json`, кеш в процессе | `user:channel:recipient` | вечно, отзыв `revokeSendMatching` |
| Резолв получателей | `memory/resolution-memory.ts` | `data/resolutions.json` | `user:channel:foldName(query)` | TTL 180 д, 1000 записей |
| Рецепты сайтов | `memory/site-recipes.ts` | `data/site-recipes.json`, seed 8 хостов, общий (не per-user) | нормализованный host | 500 записей; FAIL_SUPPRESS=3 |
| Рецепты программных каналов | `memory/app-recipes.ts` | `data/app-recipes.json` | app | 200; FAIL_SUPPRESS=2 |
| База знаний (трейдинг) | `brain/knowledge/index.ts` + `docs/*.md` (24 файла) | файлы репо, read-only | домен `trading` | — |
| Журнал сон-цикла | `proactive/consolidation-journal.ts` | диск | user | — |

БД выбирается лениво в `db/pool.ts`: `testClient` (PGlite, `__setQueryClientForTests:44`) > `pglite://<dir>` > `postgres://` > no-op.
Любая ошибка запроса = `null` (логируется), вызывающий деградирует. Таймауты pg: connect/query/statement 4 с.
Эмбеддер (`gateway/server.ts:176-186`): OpenAI при `OPENAI_API_KEY`, иначе `LocalEmbeddingProvider` (e5-small, 384d), поверх `CachingEmbeddingProvider`.
Колонка `embedding` = VECTOR(384) (миграция 0005), поэтому любой тест-эмбеддер обязан быть 384-мерным.

### 1.2 Сквозные потоки

**Чтение (каждый ход)**: `handleUserText` -> `loop/retrieval.ts:retrieveContext:43` параллельно (таймаут 350 мс голос / 700 мс текст):
1. `episodic.hasEntries` (150 мс, кеш `known`) -> `episodic.search(k=5, minScore=memoryMinScore())`; порог 0.82 (e5), `OPENAI_API_KEY` -> 0, env `JARVIS_MEMORY_MIN_SCORE`.
2. `skills.recall` -> `listSkillsMerged` (свои + общие, частный перекрывает) -> `recallSemantic` (`skill-recall.ts:247`) либо лексика `matchLearnedSkill:145`.
3. `skills.learnedCatalog` (используется только при промахе recall/блоке подсказки).
Затем `skillHintBlockReason:20`: разговорный ход / нет командного глагола / raw cos < 0.86 без якоря (`skill-anchors.ts`) -> подсказка не идёт в промпт (`suppressSkillHint`).
`loop/prompt.ts:37-60`: `profile.facts` = asserted-блок «Известные факты» с возрастом (`fact-age.ts:53`), эпизодический recall = отдельный хеджированный блок `recalledMemories` (дедуп против профиля).

**Запись факта**: инструмент `memory_write` (`dispatch.ts:947`) или рефлекс `memory-reflect.ts:88` (на реплику с маркером, `JARVIS_MEMORY_REFLECT`, кап 8) или сон-цикл -> `writeUserMemory` (`user-memory.ts:45`):
поиск соседей (k=6) -> top ≥ 0.93 = «duplicate» -> `episodic.write` (вектор `passage`; если эмбеддер вернул null, строка пишется с `embedding NULL` и вернётся только после `backfillMissingEmbeddings` на boot) -> `addFact` в профиль (fact/preference) -> fire-and-forget хук противоречий (`contradiction-hook.ts`, соседи 0.70-0.93, дешёвая LLM, JSON-номера) -> `episodic.supersede` + `removeFactExact`. Хук не ответил = ничего не помечать.
Гейты: `ctx.devSession` -> запись пропущена; `ctx.unaddressedTurn` -> declined.

**Забывание**: `memory_forget` -> `forgetUserMemory:130`: `markStale` (порог `forgetMinScore()` 0.85 e5 / 0.6 OpenAI, до 5) + `removeFactsMatching` (пословно, needle ⊆ fact, ≥2 токенов, кап 5). UI: `memory.forget` (`router-ws.ts:1092` -> `forgetMemoryItem:354`) -> `markStaleById` + `removeFactExact` (точное).

**Навыки**: `skill_save` (`handlers/skills.ts:241` -> `provider.save` `skills.ts:799+`): скан `scanSkillContent` -> карантин; дедуп (slug, затем семантика 0.93/`JARVIS_SKILL_DEDUP_SEMANTIC_MIN`); дистилляция нескольких демо (LLM-дистиллятор, повторный скан); `serializeLearnedSkill` -> `saveSkill` (upsert, version++) -> файл. Самообучение: `loop/finalize.ts:29` -> `self-learn.ts:21` (нудж модели «сохрани приём», до MAX_SELF_LEARN_STEPS, гвард трат §14). `skill_promote` -> перескан -> копия в `SHARED_USER_ID`. Исход: `recordOutcome` (+1/-1 `fail_count`, подавление при ≥3 = `JARVIS_SKILL_FAIL_SUPPRESS`). Авто-макрос: `attachReplay` вписывает секцию реплея из трассы жестов (`skill-macro.ts:47/130`) со сканом только добавляемых строк. Слепой авто-реплей решает `agent/replay-gate.ts` (sim ≥ 0.92 и raw ≥ 0.84). `skill_execute` реплеит `steps` (слоты `skill-slots.ts`).
Сид общей библиотеки: `gateway/server.ts:663` `ensureUser(SHARED_USER_ID)` -> `seedSharedSkills(SHARED_SKILL_SEED)` (12 навыков `seed/shared-skills.ts`, только если версия новее, «засеяно» считается лишь по реальным записям в БД).

**Сон-цикл**: `gateway/server.ts:1027 maybeConsolidate` (первый коннект нового календарного дня, не dev, не заморожено, throttle, `claimConsolidationRun`) -> `consolidateMemory` (`consolidation.ts:103`): вчерашние реплики (без `unaddressed`) + заголовки задач -> LLM sonnet -> до 5 фактов -> фильтр `looksLikeDirective:82` -> `writeUserMemory(source=consolidation)` -> журнал прогона.

**Рабочая память**: `router-ws.ts:390` `loadWorkingMemory(userId)` (dev-сессия — чистая `WorkingMemory` без диска), `pushTurn` на каждую реплику, `flushWorkingStores` на close.

**Согласия**: `approveSend` после подтверждённой отправки (mail.ts:205, messaging.ts:143/298/374/387), `isSendApproved` в `send-guards.ts`, `revokeSendMatching` (messaging.ts:507). Защита периметра §14 — только снижение трения, первое разрешение всегда явное.

**Резолв**: `messaging.ts:98` recall -> быстрый путь по peerId; `:160` remember на верифицированной доставке; `:175` forget при resolve-ошибке (самоисцеление).

### 1.3 Инварианты и пороги (все откалиброваны на e5-small, не на Hash)

| Что | Значение | Env | Файл |
|---|---|---|---|
| Порог авто-retrieval | 0.82 (OpenAI: 0) | `JARVIS_MEMORY_MIN_SCORE` | episodic.ts:129 |
| Дедуп записи | 0.93 | — (константа) | user-memory.ts:14 |
| Зона противоречий | 0.70-0.93 | `JARVIS_CONTRADICTION_HOOK=0` выкл | contradiction-hook.ts:29 |
| Забывание | 0.85 (OpenAI 0.6) | `JARVIS_MEMORY_FORGET_MIN` | user-memory.ts:29 |
| Recall навыка семантика | 0.82 | `JARVIS_SKILL_SEMANTIC_MIN` | skill-recall.ts:204 |
| Лексика recall | 0.34 | `JARVIS_SKILL_RECALL_MIN` | :46 |
| Буст платформы / лексики / floor raw | 0.1 / 0.2 / 0.7 | `..._PLATFORM_BOOST/_LEXICAL_WEIGHT/_RAW_COS_FLOOR` | :119-136 |
| Подсказка навыка в промпт | raw ≥ 0.86 или якорь | — | retrieval.ts:16 |
| Авто-реплей | sim ≥ 0.92, raw ≥ 0.84 | `JARVIS_AUTO_REPLAY_MIN_SIM/_RAW_COS` | replay-gate.ts |
| Уверенный recall для учёта исхода | raw ≥ 0.9 | — | loop/finalize.ts:11 |
| Провалы навыка -> подавление | 3 | `JARVIS_SKILL_FAIL_SUPPRESS` | skill-recall.ts:56 |
| Кап фактов сон-цикла | 5/день | — | consolidation.ts:31 |
| Кап рефлекса | 8 | `JARVIS_MEMORY_REFLECT_CAP` | memory-reflect.ts:53 |

Законы CLAUDE.md, которые здесь охраняются: честность исхода (`saveSkill` кричит, когда навык лёг только в память процесса; `seedSharedSkills` не врёт «засеяно»; `forgetUserMemory` честно «не нашёл»; `KnowledgeBase.consult` честный `matched:false`); недоверенный контент (`<untrusted_content>` в хуке противоречий и сон-цикле; скан навыков `skill-scan.ts` на записи, promote и attachReplay); мультитенант (userId в ключах консента/резолва/кеша триггеров `triggerVecKey`).

## 2. Возможности

Полный список — в JSON (`capabilities`, 36 шт.). Кратко по группам:

| Группа | Capability id | Вход |
|---|---|---|
| Эпизодика | episodic-search, episodic-write, episodic-backfill, episodic-supersede, episodic-forget-stale, episodic-list-ui | episodic.ts:181/211/239/325/262/285 |
| Запись/забывание | memory-write-tool, memory-forget-tool, memory-search-tool, memory-reflex, contradiction-hook | dispatch.ts:947/963, info.ts:64, memory-reflect.ts:88, contradiction-hook.ts:62 |
| Сон-цикл | consolidation-sleep-cycle | server.ts:1027, consolidation.ts:103 |
| Retrieval | turn-retrieval, skill-hint-gate | retrieval.ts:43/20 |
| Навыки | skill-recall-semantic, skill-recall-lexical, skill-save, skill-self-learn, skill-promote, skill-outcome-suppress, skill-scan-quarantine, skill-macro-replay, skill-slots, skill-execute, shared-skills-seed | skills.ts, skill-recall.ts, finalize.ts, skill-macro.ts, skill-slots.ts, handlers/skills.ts:33, server.ts:663 |
| Профиль | profile-facts, profile-settings, fact-age-labels, memory-tab-ui | profile.ts:291, fact-age.ts:53, router-ws.ts:277 |
| Согласия | consent-send | consent.ts:46/51/83 |
| Рабочая память | working-memory, working-store-persist | working.ts, working-store.ts:37 |
| Рецепты | site-recipes, app-recipes, resolution-memory | site-recipes.ts:57, app-recipes.ts:61, resolution-memory.ts:57 |
| Знания | knowledge-consult | info.ts:41, knowledge/index.ts:121 |

## 3. Швы (как подменить в лаборатории)

| Шов | Как |
|---|---|
| БД | `__setQueryClientForTests` (`db/pool.ts:44`) + PGlite (`@electric-sql/pglite` + `/vector`). Рабочий образец: `db/persistence.integration.test.ts`, `product/test-db.ts`. Либо `DATABASE_URL=pglite://<dir>` для всего сервера (`pool.ts:75`). Нужны миграции `infra/migrations/0001..0006` по порядку (+ `0002_seed_dev` даёт DEV_USER и `open-browser`), продуктовые не нужны. `ensureUser(SHARED_USER_ID)` обязателен перед сидом общей библиотеки (FK). |
| Эмбеддер | `HashEmbeddingProvider(384)` (`integrations/openai-embeddings.ts:96`, bag-of-words) — только с размерностью 384; дефолт 256 сломает INSERT (pool.query вернёт null, ошибка в логе). Для реалистичных порогов: `LocalEmbeddingProvider` (e5, `~/.jarvis/models/hf`, на Windows `JARVIS_EMBED_DEVICE=dml`) — пример `seed/lms-quiz-recall-e5.test.ts`. `StubEmbeddingProvider` (null) для проверки деградации. |
| Порог retrieval | env `JARVIS_MEMORY_MIN_SCORE` (для Hash понизить, у Hash косинусы иные) |
| LLM (хук, сон-цикл, рефлекс, дистиллятор, самообучение) | `ILlmProvider`; `MockLlmProvider`/`ScriptedLlm` (`gateway/bench/scripted-llm.ts`); дистиллятор — DI-параметр `createSkillProvider(embedder, distiller)` |
| Диск | `JARVIS_DATA_DIR` (vitest.setup создаёт tmp-каталог); все пути ленивые (`paths.lazyDataPath`). `loadSiteRecipeStore(dir)`, `loadResolutionMemory(now, dir)`, `readPersisted/writePersisted(dir)` принимают каталог |
| Часы | `ResolutionMemory(now)`, `SiteRecipeStore(now)` принимают `now`; остальное (`working-store` TTL, `fact-age`, `maybeConsolidate` `toDateString`, `recall` TTL) — на глобальном `Date.now()`, значит `vi.useFakeTimers()`/`setSystemTime` |
| Профиль/консент | глобальный кеш модуля: `loadProfile`, `_resetConsentForTest` (`consent.ts:148`), `resetAppRecipesForTest` |
| Сессия без записи | dev-сессия (`clientVersion` «dev»/«bench», `isDevSession`) НЕ пишет память/навыки/задачи и не самообучается. Для проверки записи нужна не-dev сессия либо прямой вызов `writeUserMemory`/`createSkillProvider`. При этом retrieval dev-сессии читает общий `brain.episodic` под DEV_USER = владелец. |
| Стенд | `gateway/bench/bench-hub.ts` (bench-сессия, `ScriptedLlm`, dev-изоляция) |

## 4. Как проверять без человека

| Возможность | Достаточно | Тесты сейчас | Не покрыто |
|---|---|---|---|
| Эпизодика (in-memory) | юнит + HashEmbedding | `memory/episodic.test.ts`, `episodic-ranking.test.ts` | PG-пути `markStale/supersede/listSuperseded/backfill` против PGlite: только базовые в persistence.integration |
| Эпизодика (pg) | PGlite + все миграции | `db/persistence.integration.test.ts` | **схема теста без миграции 0005** (VECTOR(1536), Hash(1536)); dim=384 в бою не проверялся |
| writeUserMemory, forget | fake-llm | `user-memory.test.ts`, `contradiction-hook.test.ts`, `fact-age.test.ts` | реальная цепочка write -> hook -> supersede на pg |
| Навыки CRUD/recall | PGlite + fake embed | `skills.test.ts` (677 строк), `skill-*.test.ts`, `intent-polarity.test.ts` | реальные пороги e5 покрыты только в `seed/lms-quiz-recall-e5.test.ts` (для одного навыка; пропускается без модели) |
| Seed общей библиотеки | PGlite | `skills-seed.test.ts`, `seed/shared-skills.test.ts` | загрузка на boot по всему пути gateway |
| Самообучение / исход / макрос | fake-llm через петлю | `skill-hint-gate-loop.test.ts`, `skill-prefill.test.ts`, `brain/agent/*-loop.test.ts` (косвенно) | живая дистилляция несколькими показами, реальный `attachReplay` из трассы sidecar (needs fake-desktop) |
| Сон-цикл | fake-llm + fake-clock | `proactive/consolidation.test.ts`, `consolidation-journal.test.ts` | триггер `maybeConsolidate` (server.ts:1027) — приватная функция без теста; реальный день/TTL |
| Профиль/консент | tmp dir | `brain/profile.test.ts`, `brain/consent.test.ts` | конкурентная запись `persist` |
| Рабочая память | tmp dir + fake-clock | `working.test.ts`, `working-store.test.ts` | flush на graceful shutdown (server close) |
| Рецепты/резолв | unit | `site-recipes.test.ts`, `resolution-memory.test.ts`, `brain/app-channels.test.ts` | learned-путь site-recipes не вызывается из прода (см. дефекты) |
| Знания | unit | `brain/knowledge/knowledge.test.ts` | качество ранжирования на реальных вопросах |
| Инструменты memory_* | fake-llm + fake-desktop-не-нужен | `brain/agent/index.test.ts`, `unaddressed-loop.test.ts`, `error-voice.test.ts` | — |
| Вкладка «Память» (UI) | текст-сессия + WS-кадр `memory.request` | нет прямого теста router-ws | end-to-end кадр `memory.forget` |
| Качество recall в живой речи (STT-формулировки, шум e5) | **real-brain + реальный e5** | частично lms-quiz | это `liveOnly`-подобное: только по данным владельца (реплики из логов) |

Никакая из возможностей этой подсистемы не требует микрофона или GUI ПК; liveOnly = только калибровка порогов на живом корпусе владельца и настоящие STT-формулировки.

## 5. Дефекты и долг

| Сер. | Где | Что |
|---|---|---|
| med | `db/persistence.integration.test.ts:34-72` | Тест «схема §13 ↔ код» применяет 0001+0002+0006, но НЕ 0005 (VECTOR(384)); столбец 1536d, эмбеддер `Hash(1536)`. Бой (384d) не проверен, дрейф схемы зелёный. |
| med | `memory/skill-recall.ts:46/56/119/125/136/205/171/348`, `agent/replay-gate.ts:29`, `site-recipes.ts:27`, `app-recipes.ts:33` | Пороги читаются из env на ЗАГРУЗКЕ модуля. `.env` грузится ПОСЛЕ ESM-хойстинга (грабля из CLAUDE.md) => `JARVIS_SKILL_*` из `.env` молча игнорируются. `memoryMinScore/forgetMinScore` уже сделаны функциями, остальные нет. |
| med | `memory/site-recipes.ts:57-131` | Мутирующий API (`upsert learned`, `reinforce`, `demote`) не вызывается из прод-кода (только `recall` в `handlers/browser.ts:70`): «learned» рецептов не бывает, `failCount` не растёт, self-heal мёртв. Заявленное в шапке «авто-обучение» — отсутствует. |
| med | `gateway/server.ts:1027` + `working-store.ts:16` | Сон-цикл берёт «вчерашние реплики» из рабочей памяти с TTL 12 ч: при утреннем коннекте после ночного простоя >12 ч реплик нет и цикл не идёт. Работает только при коннекте в пределах 12 ч. Фактически сон-цикл срабатывает редко. |
| med | `memory/episodic.ts:425-441` vs `:262` | `InMemory.markStale` физически удаляет запись, pg-версия ставит `stale=true` (обратимо). Лаборатория на in-memory даёт иное поведение «забудь»; тест обратимости невозможен без PGlite. |
| low | `user-memory.ts:14`, `contradiction-hook.ts:29-30` | `DEDUP_MIN=0.93` и зона 0.70-0.93 жёстко зашиты под e5; в отличие от `memoryMinScore/forgetMinScore` не embedder-aware (при OpenAI-эмбеддере дедуп/хук почти не срабатывают). |
| low | `skills.ts:49, 445-465` | Фолбэк `memSkills` наполняется, когда запрос упал при живой БД, а чтение (`getSkill/listSkills`) при живой БД его игнорирует: навык «сохранён» (persisted:false), но в recall не виден до рестарта. Отражено флагом `persisted`, потребители его не все проверяют. |
| low | `skills.ts:1034 строки`, `episodic.ts:479`, `dispatch.ts` | Нарушение закона «модуль < 150 строк» (старые файлы, правило: без запроса не рефакторить). |
| low | `agent/memory-reflect.ts:12` | Комментарий «(4) кап 20 фактов в профиле» устарел: кап 50 (`profile.ts:184`). |
| low | `consent.ts:30-32` | Ключ согласия: `toLowerCase()`, а `revokeSendMatching` сверяет через `foldName` (ё/украшения) - нормализации разные; «Катя»/«Катя 💗» это разные согласия, отзыв же ловит оба. |
| low | `episodic.ts:181-195` | pg-поиск фильтрует `stale/invalid_at` после ANN-выборки HNSW с `limit k`: при большом числе stale-соседей у запроса вернётся меньше k релевантных (нужен `hnsw.ef_search`/итеративное сканирование). Не воспроизводилось, по чтению. |
| low | `episodic.ts:211-238` | Строка без вектора (эмбеддер null) пишется с `embedding NULL` и невидима поиску до перезапуска сервера (backfill только на boot, `server.ts:656`). |
| info | `brain/knowledge` | Единственный домен `trading`; поиск — подстроки по заголовкам/телу (без стемминга, без эмбеддингов). Не дефект, но потолок качества «консультации». |

Не найдено: утечек между тенантами в кешах (ключ `ownerId:id`), забытых секретов, TODO с обещанием.

## 6. Что должна уметь лаборатория ради этой подсистемы

1. Поднимать изолированную PGlite со ВСЕМИ миграциями `0001..0006` (без 0005 схема не боевая), сидом DEV_USER и `ensureUser(SHARED_USER_ID)`; уметь пересоздавать per-сценарий и грузить снимки.
2. Фейковые эмбеддинги 384d (Hash(384)) с переопределяемым `JARVIS_MEMORY_MIN_SCORE`, плюс опциональный режим настоящего e5 (`JARVIS_EMBED_DEVICE=dml`) для калибровочных сценариев; явный флаг, какой режим включён.
3. Скриптованный LLM для хука противоречий, рефлекса, сон-цикла, дистиллятора и самообучения (`ScriptedLlm`), с проверкой, что вызовов «не было» там, где флаг выключен.
4. Управляемые часы: `Date.now` для TTL working-store (12 ч), возраст фактов, сутки сон-цикла, TTL резолва (180 д); `JARVIS_DATA_DIR` в tmp на сценарий.
5. Не-dev bench-сессия (или прямые вызовы `writeUserMemory/createSkillProvider`) для проверки записи: dev-изоляция отключает `memory_write/skill_save/самообучение`. Отдельная БД и data dir, иначе retrieval dev-сессии читает память владельца (DEV_USER = владелец).
6. Сценарии-«рестарт»: закрыть/переоткрыть сессию с тем же data dir и PGlite dir (`pglite://`) для проверки персиста, `flushWorkingStores`, backfill эмбеддингов, повторного сида.
7. Корпус реплик (из логов владельца) для регрессии recall и подсказки навыка, с метками ожидаемого попадания/промаха; отдельный прогон только с реальным e5.
