# Карта: integrations-product-self

Область: `apps/server/src/integrations/*`, `product/*`, `self/*`, `brain/mcp/*`, `billing/`, `obs/*`. Только чтение кода, ничего не запускалось. Пути относительно `apps/server/src/`. Машинная версия: `integrations-product-self.json`.

## 1. Как работает

### 1.1 Мозг (LLM)

Поток хода: `handleUserText` -> `brain.llm` (`ILlmProvider`, `integrations/llm.ts:154`) -> `complete`/`completeStream` -> `LlmResponse` (`text`, `toolUses`, `stopReason`, `usage`, `stubbed`, `channel`, `modelUsed`).

Сборка в `gateway/server.ts:192-225`:

```
AnthropicLlmProvider (API по ключу, anthropic.ts:99)  --primary-->  FallbackLlmProvider (fallback-llm.ts)
SubscriptionLlmProvider (Agent SDK, subscription-llm.ts:391)  --secondary-->        |
                                                                                    v
                                                                            brain.llm = anthropicLlm
```

- Продуктовый режим (`config.product.enabled`): подписка НЕ создаётся; если задан `CLAUDE_CODE_OAUTH_TOKEN` - `throw` на старте (`server.ts:213`).
- Решение владельца 2026-08-31/09-09: API по ключу выключен, реально работает подписка Max (модель `opus` -> `claude-opus-5-5`, `subscription-llm.ts:175-195`; эффорт по тиру medium/high/max, `:245`, thinking всегда adaptive).
- Признак отказа основного канала: провайдер API по дизайну не бросает, а возвращает `stubbed:true, stopReason:"stub"` (`fallback-llm.ts:5-9`).
- Стейт-машина `FallbackLlmProvider`:
  - `primaryWorthTrying` (`:123`): нет ключа / `JARVIS_PRIMARY_LLM=0` / латч `primaryOff` / пауза `skipPrimaryUntil` -> сразу резерв.
  - `notePrimary` (`:152`): терминальные `credits`/`auth` (только при живом резерве) -> латч "off" на `JARVIS_PRIMARY_RECHECK_MS` (деф 6 ч, `0` = до рестарта; пустая строка = деф). Транзиентные: 2 подряд -> пауза `JARVIS_PRIMARY_COOLDOWN_MS` (деф 5 мин; region 403 - не меньше 30 мин, досрочное снятие `RegionPauseHeal` при ожившей подписке).
  - `completeStream`: дельты основного пробрасываются сразу; если основной отказал ПОСЛЕ дельт - резерв не пробуем (нет двойного голоса), ход честно провален (`:237-262`).
  - `JARVIS_FORCE_SUBSCRIPTION=1`: все ходы сразу в подписку.
  - Оба канала мертвы -> стаб (`stopReason:"stub"`), петля считает ход проваленным (закон честности); текст стаба - `withKnownReason` по `lastSubscriptionFailure()`.
- `channelStatus()` (`:200`) отдаёт паспорту возможностей: primary `ok|cooldown|off` + причина + `subscriptionLive`.
- Подписочная сессия (`subscription-llm.ts:490-`, `subscription-session.ts`): одна сессия Agent SDK на задачу (`LlmRequest.sessionKey` = id задачи, максимум 6 сессий, ход до 10 мин, ожидание инструмента до 10 мин). Модель просит инструмент -> in-process MCP-хендлер SDK ждёт результат НАШЕЙ петли -> следующий `completeStream` с `tool_result` продолжает ту же сессию (`continuationOutcomes`). Сброс сессии: другой отпечаток (модель/эффорт/инструменты), петля переписала историю (`historyRewritten`, порог картинок), сессия умерла. `release(key)` обязан вызываться петлёй в `finally`.
- Изоляция подпроцесса CLI: `ANTHROPIC_API_KEY` вычищен из env, `settingSources: []`, пустой cwd `data/sdk-cwd`, `persistSession:false`, `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`, `MAX_MCP_OUTPUT_TOKENS=40000`.
- Авторизация подписки: `CLAUDE_CODE_OAUTH_TOKEN` ИЛИ файл `~/.claude/.credentials.json` (`hasStoredLogin`, `:59`). `live` = включено (`JARVIS_SUBSCRIPTION_FALLBACK!=0`) и есть один из двух.
- Деньги: `channel:"subscription"` -> `chargedCostUsd=0` (`obs/pricing.ts:101`), подписочные ходы не жгут долларовый потолок SpendGuard.

### 1.2 Голос

- `providers.ts`: STT = deepgram (есть `DEEPGRAM_API_KEY`) | whisper (по умолчанию без ключа!) | mock (только `STT_PROVIDER=mock`). TTS: `TTS_PROVIDER=yandex3` + `YANDEX_API_KEY` -> v3-стрим; `yandex` -> v1; `ELEVENLABS_API_KEY`+voiceId -> ElevenLabs; иначе Mock. Сверху `CachingTtsProvider` (`server.ts:146`, TTL 6 ч, 500 записей).
- `DeepgramSttProvider` (`deepgram.ts:988`): `open(opts)` отдаёт LeasedTurn на ход; персистентный WS (`JARVIS_DEEPGRAM_PERSISTENT!=0`), AGC (`StreamAgc`), seal-quiet (`JARVIS_DEEPGRAM_SEAL_QUIET_MS`), до 5 реконнектов посреди фразы, `classifyEmptyFinal` (lost|silence). Модель `DEEPGRAM_MODEL` (nova-3). URL зашит: `wss://api.deepgram.com/v1/listen` (`:42`).
- `deepgramTranscribeOnce` (`deepgram-once.ts:9`): REST-подстраховка слова "Джарвис", таймаут 4 с.
- `WhisperSttProvider`: буферизует фразу, транскрибирует на close, нормализует по пику, дропает галлюцинации.
- TTS: контракт `synthesize(text, opts) -> TtsStream{onChunk,onError,onDone,cancel}`; эмоция/скорость - `tts-emotion.ts`, `speedupConfigFromEnv`/`adaptiveSpeed` (`voice-providers.ts:161-215`, `JARVIS_TTS_SPEEDUP*`).

### 1.3 Эмбеддинги и веб

- Эмбеддер в `server.ts:180-187`: `OPENAI_API_KEY` -> OpenAI (опт-ин, платный), иначе `LocalEmbeddingProvider` (e5-small 384, `local-embeddings.ts:62`, веса в `~/.jarvis/models/hf` или `JARVIS_MODELS_DIR`, cooldown после сбоя `JARVIS_EMBED_COOLDOWN_MS`); при сбое `embed` возвращает `null` (память пустая, не мусор). Поверх `CachingEmbeddingProvider`.
- Веб: `CachingWebProvider(WebProvider(braveKey))`. Поиск: Brave при `BRAVE_SEARCH_API_KEY`, иначе DuckDuckGo Lite. Fetch: `isFetchUrlAllowed` на каждый hop (макс 5 редиректов, ручные), `pinnedTransport` (B-14, DNS внутри `lookup` сокета), стриминговое чтение с капом 2 МБ, декодинг по заявленной кодировке, усечение помечается.
- Почта: `smtpSend` (implicit TLS/STARTTLS/none, три исхода: принято / не ушло / `SmtpUncertainError`), `imapFindMessage` (сверка по Message-ID в "Отправленных"). Потребители: `brain/tools/handlers/mail.ts:136+` (`mail_send`) и `product/gateway-hooks.ts` (`sendOtpMail`).

### 1.4 Продуктовый каркас (`product/*`)

- Мастер `JARVIS_PRODUCT_MODE` (деф 0). `resolveProductFlags(env)` (`policy.ts:79`) - чистая функция; инвариант "при 0 все подфлаги false" проверяется тестом. Подфлаги: `AUTH`, `QUOTAS`, `BILLING`, `LLM_PROXY`, `LIBRARY`, `TELEMETRY`, провайдер оплаты `none|fake|yookassa`, роль `all|node|brain`, `exposed` (brain / ALLOW_REMOTE / TRUST_PROXY / PRODUCT_EXPOSED) - при exposed нужен `JARVIS_ADMIN_TOKEN`, fake-провайдер принудительно выключается.
- `createProductRuntime` (`gateway-hooks.ts:142`): handshake (`resolveHello` -> `resolveProductIdentity`), квоты (`QuotaResolver` -> лимиты SpendGuard по плану), `usageSinkFor` -> ledger, пороги soft/hard 80/100 с озвучкой (retriable), `pushUsage` после оплаты, таймер жизненного цикла подписок `LIFECYCLE_SWEEP_MS`=10 мин.
- Вход: `POST /v1/auth/otp/request|verify` (OTP 10 мин, 5 попыток, лимиты 5/час на email и 20/час на IP), токены `jdt_` (device, 365 дн, ротация после 30), `jat_` access, `jrt_` refresh; pepper для хэша email.
- Деньги: `credits.ts` (гранты, `consumeCredits`), `ledger.ts` (llm/stt/tts, период), `subscriptions.ts`/`invoices.ts`, вебхук `processWebhook` (идемпотентность, сверка суммы). ЮKassa: сумма и статус перечитываются GET в API, контракт "живьём не проверен" (`yookassa.ts:2`).
- Роуты: `/v1/meta`, `/v1/auth/*`, `/v1/me*`, `/v1/subscription*`, `/v1/usage`, `/v1/admin/*` (users, grant, kill, plans, sweep, reports), `/webhooks`, `/dev/product/*` (только dev). БД: продуктовые миграции `infra/migrations-product/*.sql`.

### 1.5 Самоправка (`self/*`)

Цикл `self_patch`: `begin` (ветка `self/*`, только от чистого дерева) -> правка обычными инструментами -> `verify` (worktree на sha коммита, `tsc`+`vitest` внешним процессом, env очищен от секретов) -> `commit` -> `apply` (confirm владельца "irreversible", merge; после нужен рестарт) | `abort`. Рельсы: `PROTECTED_PATHS` + `PROTECTED_CONFIG` (`patch.ts:36-100`), зелёный статус привязан к sha, удаление тестов отслеживается (`removedTests`). Состояние в `data/self-patch.json`. Вокруг: `self_weaknesses` (метрики+логи, `weaknesses.ts`), `self_code_read/search` (`repo.ts`, allowlist расширений, секреты и `data/` исключены), проактивный самоосмотр (`proactive/self-review.ts`, вызов `router-ws.ts:620`).

### 1.6 MCP-host

`McpManager` (`brain/mcp/manager.ts:119`): `connectAll()` fire-and-forget из `listen()` (`server.ts:638`), `allSettled`, инструменты холодные (`mcp__<server>__<tool>`), stdio (env ребёнка = базовый allowlist + объявленный `sc.env`) или StreamableHTTP, `requiresConfirm`/`declaredEffect` из `mcp.json` (`confirm`, `toolEffect`), `callTool` не бросает (isError), картинки нормализуются (только jpeg/png/gif/webp, до 4). `mcp.json` в `PROTECTED_PATHS` самоправки.

### 1.7 Наблюдаемость

- `metrics` (синглтон, `obs/metrics.ts:416`): `record` события задачи (тир/модель/usage/ok/`failKind`/фактическая стоимость), агрегаты (`aggregate`, перцентили), durable `data/logs/metrics.jsonl` (`enableJsonl` из `listen`, ротация по размеру `JARVIS_METRICS_MAX_BYTES` деф 64 МБ), `startProcessHealth` (каждые 5 мин), предупреждение о диске (`JARVIS_DISK_MIN_FREE_MB`), деградации (`recordDegradation`).
- `FileLogSink` (`file-log.ts:65`): `data/logs/server-YYYY-MM-DD.log` JSONL, ретенция `JARVIS_LOG_RETENTION_DAYS` (деф 7) - чистит только server-*.log, не metrics.
- `SpendGuard(s)` (`billing/index.ts:61,330`): потолок трат, killswitch, макс шагов/токенов, гвард на пользователя, персист `usage_quota`.

## 2. Возможности

Полный список (54 capability, id/entry/trigger/needs/testedBy) - в JSON. Сводка по группам:

| Группа | Capability (id) | Триггер | Что нужно |
|---|---|---|---|
| LLM | `llm.contract-mock`, `llm.scripted-bench`, `llm.fallback-chain`, `llm.channel-status`, `llm.primary-cooldown`, `llm.api-error-classify` | текст/событие | fake-llm, fake-clock |
| LLM (платное) | `llm.anthropic-api` (liveOnly), `llm.subscription-brain`, `llm.subscription-continuity`, `llm.subscription-errors`, `llm.subscription-warmup` (liveOnly) | текст | fake sdk или real-brain по подписке |
| Голос | `stt.factory`, `stt.deepgram-stream`, `stt.deepgram-rest-rescue`, `stt.whisper-local`, `stt.mock`, `tts.factory`, `tts.yandex-v1`, `tts.yandex-v3`, `tts.elevenlabs`, `tts.cache`, `tts.emotion-speedup`, `tts.mock` | голос | audio-replay, mock |
| Память | `embed.local-e5`, `embed.openai` (liveOnly), `embed.hash-and-cache` | инструмент | db, веса e5 |
| Веб/почта | `web.search`, `web.fetch`, `web.cache-mock`, `mail.smtp-send`, `mail.imap-verify` | инструмент | fake-web, loopback SMTP/IMAP |
| Продукт | `product.policy`, `product.runtime`, `product.auth-otp`, `product.tokens-identity`, `product.accounts-lifecycle`, `product.quota-ledger-credits`, `product.subscriptions-sweep`, `product.billing-fake`, `product.billing-yookassa` (liveOnly), `product.routes`, `product.reports`, `product.models-rate-limit`, `billing.spendguard` | UI/время/событие | db (PGlite), fake-clock |
| Самоправка | `self.weaknesses`, `self.code-read-search`, `self.patch-cycle`, `self.verify`, `self.review-proactive` | инструмент/время | git-песочница, owner для apply |
| MCP | `mcp.host`, `mcp.call-tool` | событие/инструмент | фикстурный stdio-сервер |
| Наблюдаемость | `obs.metrics`, `obs.file-log`, `obs.pricing` | событие | tmp data dir |

## 3. Швы (seams) и как подменять

| Шов | Где | Как фейкнуть |
|---|---|---|
| Мозг | `llm.ts:154` | `MockLlmProvider(script)`; на стенде `ScriptedLlm` в `ctx.agentDeps.llm` (`gateway/bench/bench-hub.ts:56`). `createGateway` провайдеры не принимает. |
| Agent SDK | `subscription-llm.ts:370` (`SdkModule`) | `new SubscriptionLlmProvider({loadSdk})` + `scriptedSdk(steps, realTool)` (`integrations/test-support/scripted-sdk.ts`): сценарий шагов, usage растёт с историей сессии. |
| Защита лимита подписки | `subscription-llm.ts:59,416` | `JARVIS_SUBSCRIPTION_FALLBACK=0` и HOME/USERPROFILE на пустой каталог. Bench так и делает. |
| API по ключу | `anthropic.ts:99` | пустой ключ -> стаб; `ANTHROPIC_BASE_URL` -> локальный фейковый Messages API; `JARVIS_PRIMARY_LLM=0`. |
| Часы LLM-предохранителя | `fallback-llm.ts:139` | 4-й аргумент `now`, но `wallStart`/`lastApiFailure().at` - `Date.now()`; нужны fake timers или `_setApiFailureForTest(text,status,atMs)`. |
| STT | `providers.ts:22` | `STT_PROVIDER=mock`; `MockSttProvider(["фраза1", ...])` (финал на close), `emitPartial`. Deepgram: подмена `globalThis.WebSocket`/`fetch`; URL зашит. |
| TTS | `providers.ts:43` | без ключей -> Mock; `MockTtsProvider` уважает cancel. |
| Эмбеддинги | `server.ts:180` | `HashEmbeddingProvider` (детерминированный) в юнитах; в сервере inline `LocalEmbeddingProvider`. Веса: `JARVIS_MODELS_DIR`, `HF_ENDPOINT`, `JARVIS_EMBED_DEVICE/DTYPE/DIM/MODEL`. |
| Веб | `web.ts:519` | `MockWebProvider(hits,page)`; `WebProvider(key, transport)`; `pinnedTransport(lookup, interfaces)` DI резолвера. HTTPS-фикстуры стенда: `infra/bench/sites`. |
| SMTP/IMAP | `handlers/mail.ts:136` | `MAIL_SMTP_HOST/PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_SMTP_TLS=none`, `MAIL_IMAP_TLS=none`, `MAIL_IMAP=0`; фейк-серверы `fakeSmtp/fakeImap` в `mail.test.ts`. |
| БД | `product/test-db.ts:40` | `openProductTestDb()` (PGlite + миграции 0001-0003 + `migrations-product`), `DATABASE_URL=pglite://`. |
| Оплата | `gateway-hooks.ts:113` | `JARVIS_BILLING_PROVIDER=fake` + `FakePaymentProvider.makeEvent`; `/dev/product/webhook`. YooKassa принимает `fetch`. |
| Часы продукта | `gateway-hooks.ts:142` | `createProductRuntime(cfg, spend, {now, env})`; токены `{now: Date}`; `/dev/product/sweep`. |
| Самоправка | `self/repo.ts:68` | `_setSelfRepoRootForTest(dir)`; `verifyChanges(files, rootDir)`; state под `JARVIS_DATA_DIR`. |
| MCP | `mcp/config.ts:146` | пустой `mcp.json`/фикстурный stdio-сервер; юнит-тесты мокают SDK целиком. |
| Метрики/логи | `paths.ts:13` | `JARVIS_DATA_DIR`, `JARVIS_FILE_LOG=0`, `JARVIS_METRICS_JSONL=0`, `metrics.disableJsonl()`. |

## 4. Как проверять без человека

Что стоит денег или лимита подписки (в лаборатории по умолчанию мок):

| Ресурс | Кто тратит | Лаборатория |
|---|---|---|
| Anthropic API по ключу | `anthropic.ts` | выключен (ключ пуст); живой тест только `RUN_LIVE_LLM=1` |
| Подписка Max (общий лимит с Claude Code владельца) | `subscription-llm.ts`, dev-сессия `_jarvis_cmd.mjs` | по умолчанию мок; real-brain - только явной командой владельца, эффорт/модель фиксированы |
| Deepgram | `deepgram.ts`, `deepgram-once.ts` | `STT_PROVIDER=mock`; `RUN_LIVE_STT=1` не включать |
| Yandex SpeechKit / ElevenLabs | TTS-провайдеры | Mock |
| OpenAI эмбеддинги | `openai-embeddings.ts` | `OPENAI_API_KEY` пуст |
| Brave / DDG | `web.ts` | MockWebProvider или фикстуры |
| ЮKassa | `yookassa.ts` | fake-провайдер |
| CPU/диск | Whisper (~200 МБ), e5 (веса), `self.verify` (tsc+vitest минутами) | заранее положенные веса, mock STT, подмена команд verify |

Проверка по возможностям:

| Возможность | Достаточно | Тесты (есть) | Не покрыто |
|---|---|---|---|
| Контракт LLM / mock | юнит | `integrations/llm.test.ts`, `brain/agent/index.test.ts`, `gateway/test-support/voice-turn.ts` | - |
| Fallback-цепочка, латч, пауза | юнит + fake clock | `fallback-llm.test.ts` (721 стр.), `subscription-reset.test.ts` | ход на часах, разъехавшихся с `Date.now` |
| Подписочная сессия | fake sdk (scripted-sdk) | `subscription-llm.test.ts`, `subscription-session.test.ts` | реальный CLI/SDK (несовместимости версии SDK) - только real-brain; прогрев `warmup` liveOnly |
| Anthropic API | юнит на pure-части | `thinking-arg`, `system-blocks`, `anthropic-thinking-sanitize`, `api-error-classify`; `anthropic.live.test.ts` (skip) | стрим/stall-watchdog без сети, `ANTHROPIC_BASE_URL` фейк-сервер |
| Deepgram | юнит на парсер/URL + fake WS | `deepgram.test.ts` (434 стр.), `deepgram-once.test.ts`, `deepgram.integration.test.ts` (live-гейт) | реальные реконнекты/AGC на записанном звуке |
| Whisper, Yandex v3 | - | тестов нет | оба без тестов; Whisper нужны веса |
| Yandex v1 / ElevenLabs / кеш / эмоция | юнит | `yandex-tts.test.ts`, `elevenlabs.test.ts`, `cache.test.ts`, `tts-emotion.test.ts`, `voice-speed.test.ts` | env на верхнем уровне (см. дефекты) |
| Эмбеддинги | юнит + (веса) | `local-embeddings.test.ts`, `cache.test.ts` | OpenAI без теста |
| Веб | юнит + pinned DNS | `web.test.ts`, `web-ssrf.test.ts`, `pinned-fetch.test.ts` | реальный Brave/DDG (liveOnly-схема ответа) |
| SMTP/IMAP | loopback-фейки | `handlers/mail.test.ts`, `product/auth.test.ts` | TLS-режимы вживую (тесты идут с `TLS=none`) |
| Продукт | PGlite + fake clock | 19 файлов `product/**/*.test.ts` (policy, auth, tokens, identity, quota, ledger, credits, subscriptions, webhooks, routes, reports, product-mode-off, product-guards-loop, quota-loop) | ЮKassa на боевом API (liveOnly), OTP по настоящей почте, связка product-mode + реальный мозг (server.ts:213 запрещает токен подписки) |
| Самоправка | git-песочница | `patch.test.ts`, `patch-rails.test.ts`, `repo.test.ts`, `verify.test.ts`, `weaknesses.test.ts` | apply с confirm владельца в полном цикле через петлю; verify на реальном монорепо (тяжело) |
| MCP | mock SDK | `manager.test.ts`, `config.test.ts` | реальный stdio-сервер и StreamableHTTP не гоняются никем |
| Наблюдаемость | tmp dir | `metrics.test.ts`, `file-log*.test.ts`, `pricing.test.ts` | сквозная связка: ход подписки -> metrics.jsonl -> `self_weaknesses` |

Классификация liveOnly (только с ключом/железом/владельцем): `llm.anthropic-api`, `llm.subscription-warmup`, `embed.openai`, `product.billing-yookassa`. Остальное закрывается моками, фейковыми часами, PGlite и loopback-фейками. "Настоящий мозг" (real-brain) нужен только для проверки промпта/поведения модели, не для механики интеграций.

## 5. Дефекты и долг

| Серьёзность | Где | Что |
|---|---|---|
| med | `integrations/tts-cache.ts:16` | `TTS_MODEL_TAG` считается на верхнем уровне модуля до `loadEnv()` -> значения из `.env` не видны; смена движка/голоса не меняет ключ кеша (нарушение грабли "env в момент вызова"). |
| med | `product/policy.ts:47` | `llmProxy`, `library`, `telemetryEgress`, `brainUrl`, `role`: флаги и env разобраны, потребителей нет (grep по всему `src`; `llmProxy` только как `byoSupported` в `gateway-hooks.ts:149`). Флаг-мусор против закона "один флаг - одно решение", и обещанные возможности не реализованы. |
| med | `integrations/providers.ts:26` | Без ключа Deepgram и без `STT_PROVIDER` поднимается Whisper с докачкой ~150-250 МБ (`warmupWhisper` на старте, `index.ts:59`). Ловушка для лаборатории. |
| med | `integrations/subscription-llm.ts:416` | `live=true` от одного лишь файла `~/.claude/.credentials.json`: неизолированный запуск тратит общий лимит подписки. Защита только внешняя. |
| med | `gateway/server.ts:148-225` | `createGateway(config, logger)` не принимает провайдеров; LLM/STT/TTS/эмбеддер/веб строятся inline. Подмена - только bench-хаком на сессии и env. |
| low | `integrations/elevenlabs.ts:39-49` | `DEFAULT_MODEL`, `FAST_MODEL`, `FAST_MAX_CHARS` из env на верхнем уровне (та же грабля). |
| low | `integrations/yandex-tts.ts:36`, `yandex-tts-v3.ts:28` | `DEFAULT_VOICE` на верхнем уровне; смягчено передачей `voiceId` в момент вызова. |
| low | `integrations/fallback-llm.ts:229` | `wallStart=Date.now()` при инъектированных `now`: фейковые часы предохранитель не ведут. |
| low | `integrations/deepgram.ts:42`, `deepgram-once.ts:9` | URL Deepgram/Yandex/ElevenLabs зашиты, env-переопределения нет: сетевой фейк-сервер невозможен. |
| low | `integrations/yandex-tts-v3.ts:214`, `whisper-stt.ts:217`, `openai-embeddings.ts:31` | Нет собственных тестов. |
| low | `gateway/server.ts:192` | Комментарий "мозг - ТОЛЬКО облачный Opus, никаких резервных" противоречит коду ниже (Fallback + подписка). |
| low | `gateway/server.ts:213` | Продуктовый режим падает на старте при `CLAUDE_CODE_OAUTH_TOKEN`: в лаборатории нужен отдельный продуктовый профиль env. |
| low | `self/patch.ts` (451), `deepgram.ts` (1022), `subscription-llm.ts` (744), `web.ts` (690), `anthropic.ts` (506), `obs/metrics.ts` (419), `product/gateway-hooks.ts` (410) | Модули больше 150 строк (закон 3), без запроса не рефакторятся. |
| low | `brain/tools/handlers/self.ts:94` | `new Date()`/`Date.now()` для имени ветки и замера verify - часы не инъектируются. |

Проверено и в порядке: терминальный латч не выключает канал без живого резерва; стаб не бьёт по выключенному основному (`localStub()` без сети); пустая строка в `JARVIS_PRIMARY_RECHECK_MS`/`COOLDOWN_MS` обработана как дефолт; SMTP/IMAP имеют три исхода и loopback-тесты; фейковая оплата принудительно выключается при `exposed`.

## 6. Что лаборатория обязана уметь ради этой подсистемы

1. Чистое окружение по умолчанию: `JARVIS_SUBSCRIPTION_FALLBACK=0`, пустые `ANTHROPIC_*`, пустой HOME/USERPROFILE, `STT_PROVIDER=mock`, без ключей платных провайдеров, `DATABASE_URL=pglite://`, временный `JARVIS_DATA_DIR`.
2. Сценарный мозг (`ScriptedLlm`) как штатный режим и ассерты по фактам (журналы фикстур); real-brain по подписке только по явной команде владельца.
3. Фейк голоса: MockStt с очередью и проигрыванием записанного PCM, MockTts с подсчётом чанков/barge-in; подмена `WebSocket`/`fetch` для Deepgram/Yandex; запрет докачки Whisper/e5.
4. Детерминированный эмбеддер, фейковый веб/`WebTransport`, loopback SMTP/IMAP, фикстурный stdio MCP-сервер.
5. Управляемые часы (fake timers + `Date.now`) для предохранителей LLM, TTL кешей, OTP/подписок/sweep, самоосмотра.
6. Продуктовый профиль: PGlite + миграции `migrations-product`, `FakePaymentProvider`, `/dev/product/*`.
7. Самоправка в одноразовом git-репозитории с подменой команд `verify`.
8. Счётчик исходящих соединений и ассерт `chargedCostUsd=0` для подписки: гарантия, что лаборатория ничего не тратит.
