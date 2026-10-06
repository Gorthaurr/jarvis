# Карта лаборатории: gateway-session

Область: `apps/server/src/gateway/*` (server.ts, router-ws.ts, session.ts, registry.ts, identity.ts, bind.ts, heartbeat.ts,
ws-routes.ts, ext-*.ts, extension-bridge.ts, task-control.ts, voice-enroll.ts, wake-rescue-route.ts, dev-session.ts,
pre-handshake-buffer.ts, test-support/, bench/). Метод: только чтение кода, ничего не запускалось; всё, что не проверено
живьём, помечено «не проверено». Номера строк на 2026-09-29 (ветка feat/jarvis-lab).

## 1. Как работает

### 1.1 Сквозной поток одного клиента (`/ws`)

```
клиент WS -> /ws (ws-routes.ts:101) -> Origin-гард (isAllowedWsOrigin :71: пустой Origin ок, любой непустой = отказ)
  -> onClient -> onConnection (server.ts:726)
       ws.on("message") (:787): parseEnvelope -> не Envelope => error "internal/bad envelope"
         до handshake: принимается ТОЛЬКО client.hello; 5 с таймер (HANDSHAKE_TIMEOUT_MS :106, снимается
         СИНХРОННО при hello :816) -> error unauthorized + close 4001
         кадры после hello, до server.hello -> PreHandshakeBuffer (600 шт / 4 МиБ, вытесняет старейшие; кадр > 4 МиБ
           отвергается сразу), реплей в .then :846 в исходном порядке
       doHandshake (:901):
         1. isProtocolCompatible(hello.protocolVersion) иначе error version_mismatch + close 4002
         2. userId: product.resolveHello (флаг) ИЛИ resolveAndProvision(token) (identity.ts:60):
            UUID-токен => userId=токен (партиция, TOFU в auth_tokens), иначе DEV_USER
            (00000000-...-0001, либо JARVIS_DEV_USER_ID); JARVIS_AUTH_STRICT=1 + неизвестный UUID => null => close 4003
         3. loadProfile(userId) || spend.hydrate(userId) (параллельно), product.afterProvision
         4. H7 (:973): сокет закрылся за время await => сессию не поднимать (иначе flushPending в мёртвый сокет)
         5. registry.createOrResume(userId, sock, resumeSessionId) (registry.ts:26): resume только при том же userId
         6. startHeartbeat (15 с ping, 2 пропуска => ws.close(4000))
         7. session.send("server.hello", {sessionId, protocolVersion, resumed, [productMode,user,rotatedToken]})
         8. !resumed => cancelOrphanedTasks по мёртвым сессиям userId; makeSessionContext; pushSavedSkills;
            startOnboarding (:1066); maybeConsolidate (:1027)
       далее каждый кадр: `void dispatch(ctx, env)` (:865) — НЕ сериализовано (см. дефект D3)
       close (:870): heartbeat.stop, voice.dispose; если сокет уже не тот (resume) — сессию не трогать;
         иначе disposeAgent (только отписка speakers), registry.scheduleRemove (грейс 120 с, registry.ts:12)
       teardown сессии (grace истёк / shutdown): Session.teardown (session.ts:234) -> onTeardown => tasks.cancelSession
```

Обязан клиент, чтобы сервер считал его настоящим (минимум): WS без заголовка Origin; первым кадром Envelope
`{id, ts, type:"client.hello", payload:{token, clientVersion, protocolVersion:1, [resumeSessionId]}}` в течение 5 с;
отвечать `pong` на КАЖДЫЙ `ping` (иначе через ~30 с закрытие 4000); отвечать `action.result` на КАЖДЫЙ `action.command`
(commandId = id конверта, иначе таймаут 15 с/по виду команды); отвечать `user.confirm.result` на `user.confirm.request`;
называть себя в `clientVersion` по шаблону dev-сессии (`/cmd|test|driver|qa|smoke|probe|bench|script/i`, dev-session.ts:22),
если это НЕ владелец. Настоящий Electron-клиент дополнительно шлёт client.env/system/context/settings, audio.*
(в лаборатории не обязательно).

### 1.2 Session (session.ts) — состояние одного соединения

- `send` (:122): молча (WARN) отбрасывает, если `!alive` или сокет не OPEN.
- `sendAction` (:140): envelope `action.command` с `timeoutMs`; `!alive` => `disconnected`; сокет закрыт (grace) =>
  мгновенный `channel_down` (fail-fast Б4); иначе таймер => синтетический `timeout`; таймер unref.
- `requestConfirm` (:195): мёртвый канал => `outcome:"undelivered"`; окно `expiresAt` => `expired`; teardown => `undelivered`.
- `scoped(key, factory)` (:90): синглтоны, переживающие resume (workingMemory, inputArbiter, concurrency, bgTasks,
  selection, toolActivation). `rebind` (:104) подменяет сокет, in-flight сохраняются.

### 1.3 SessionContext (router-ws.ts:376 makeSessionContext, ~550 строк)

Собирает agentDeps (память, LLM, инструменты, задачи), голосовой конвейер (`createVoicePipeline`, wake-слово
обязательно, followup 12 с / окно диалога 8 с), регистрирует проактивные «озвучки» ТОЛЬКО для не-dev сессий
(reminders/watch/ambient/runner/actions, :794-848), `onOwnerPresent` (:648) — единая точка «владелец здесь» (доклад о
сбоях, брифинг дня, самоосмотр, доклад об отсутствии расширения). Dev-сессия (`isDevSession(clientVersion)`): своя
WorkingMemory (не читает/не пишет память владельца, :390), без checkpoints (:436), без speakers, без доклада/брифинга.

### 1.4 Диспетч кадров (router-ws.ts:933)

`dev.text`, `action.result`, `user.confirm.result`, `pong`, `ping`, `client.context/state/takeover/env/system/selection/
settings/keys/usage.request`, `task.control`, `memory.request/forget`, `audio.frame/vad/wake_rescue/played/playback`,
`demo.event/save`, `screen.capture.result`, `voice.enroll.*/list/remove`. Неизвестный тип => WARN. Текстовый ход
(`onDevText` :1168): управляющая фраза перехватывается ДО агента (`handleControlUtterance`), иначе `chat(user)` ->
`onOwnerPresent` -> `client.state thinking` -> `handleUserText` -> `transcript+chat+ui.display+client.state idle`.
Голоса (speak.chunk) на текстовом пути НЕТ — звук идёт только через VoicePipeline (audio.frame -> STT -> agent -> TTS).

### 1.5 Управление задачами (task-control.ts)

Порядок в `handleControlUtterance` (:87): revokeOnControl -> killswitch (freeze/unfreeze автономии, durable-латч) ->
«ложный запуск» (looksLikeMisfire) -> исключение «отмени выделение» -> classifyTaskControl: kill/silence (W0-рефлекс,
quiet 60 с / 10 мин) -> stop_tts (только барж-ин, если Джарвис говорит; иначе реплика уходит дальше) -> cancel (только если
есть что отменять) -> pause/resume/status (только при видимой активной задаче). Ack озвучивается только для
source=voice, для text/ui — в chat. `handleTakeover` — намеренный no-op.

### 1.6 Мост расширения (/ext)

`/ext` пускает только `chrome-extension://<pinned id>` (ID из `key` манифеста `pjkeladocehklaefmnhapmmpabmaeajd`, ext-id.ts,
или `JARVIS_EXT_ID`), пустой Origin отвергается. `ExtAdmission` (ext-liveness.ts:37): второе соединение при живом
предыдущем (pong за 1,5 с) отклоняется кодом 4409; мёртвое вытесняется. `ExtensionBridge.request` (extension-bridge.ts:107)
шлёт `{id, type, ...}`, ждёт `{id, ok, data|error}`, таймаут => `ext_no_reply` (исход неизвестен, закон 1). `trackExtPresence`
(ext-absence-seam.ts:14) ведёт учёт отсутствия расширения (ext-absence.ts, durable `data/ext-presence.json`).

### 1.7 Dev-HTTP (только `JARVIS_DEV_HTTP=1`, server.ts:395-510)

Гард `devPre` (:397): IP loopback (после снятия `::ffff:`) + опциональный заголовок `x-jarvis-dev-token` (`JARVIS_DEV_TOKEN`).
Без флага роуты НЕ регистрируются (404; тест bench-gating.test.ts). Роуты: `POST /ext/telegram`, `/ext/telegram_file`,
`GET /ext/tabs`, `POST /ext/tgdiag`, `/ext/reload`; `POST /dev/action {kind,...}` (последняя сессия из registry, таймаут 30 с,
минуя §14); `POST /dev/say {text}` (последний ЖИВОЙ ctx из liveCtxs, fire-and-forget, ответ в логе/клиенту); `POST /dev/vad
{state}`; `POST/GET /dev/bench/{tool,say,state,reset}` (bench-hub.ts, отдельная долгоживущая bench-сессия, сценарный мозг).
Всегда открыты (без гарда): `GET /healthz`, `/stats`, `/cogs` (расход per-user).

### 1.8 Таймеры и константы

HANDSHAKE 5 с; heartbeat 15 с x 2 промаха; RESUME_GRACE 120 с; ACTION по умолчанию 15 с (`DEFAULT_ACTION_TIMEOUT_MS`,
30 с у /dev/action); ExtAdmission ping 1,5 с; taskSweep 5 мин (retention 7 сут); PreHandshake 600 кадров/4 МиБ; онбординг
задержка 800 мс, кулдаун приветствия 6 ч; сон-цикл раз в календарный день; ext-absence пороги 2 ч / 12 ч / 10 мин.

## 2. Возможности

Полный список — в `gateway-session.json` (поле capabilities, 50+ записей). Группы: транспорт и handshake (Origin-гард, версия,
identity, resume, буфер, H7, heartbeat), Session (sendAction/requestConfirm/scoped/teardown), диспетч (dev.text, control,
task.control, context/env/system/selection/settings/usage/memory/keys, audio.*, demo.save, voice.enroll), проактив «владелец
здесь» (доклад, брифинг, самоосмотр, онбординг, сон-цикл), мост расширения, dev-HTTP, боевой boot/close, стенд bench.

## 3. Швы (seams)

| Шов | Где | Как подменить в лаборатории |
|---|---|---|
| Сокет клиента | `SessionSocket` (session.ts:26), `RawWs` (server.ts:712), `RawWsLike` (ws-routes.ts:31) | fake-сокеты `vi.fn()` (router-ws.test.ts, handshake-h7.test.ts), `BenchSocket` (bench-socket.ts) или настоящий WS-клиент по протоколу (`_jarvis_cmd.mjs`) |
| Порт/хост | `PORT`/`HOST` (config.ts:94), `resolveBindHost` (bind.ts:35) | env; НЕ-loopback без ALLOW_REMOTE+AUTH_STRICT принудительно 127.0.0.1 |
| Загрузка .env | index.ts:22 `dotenv override:true`, кандидаты env-path.ts:22 | `JARVIS_ENV_PATH=<свой файл>` (единственный способ не дать живому `apps/server/.env` перебить PORT/HOST/DATABASE_URL/EXT_ID) |
| Каталог данных | `paths.ts:13` `JARVIS_DATA_DIR`, ленивый `lazyDataPath` | отдельный абсолютный ASCII-каталог (профили, память, задачи, логи, латч автономии, ext-presence) |
| БД | `DATABASE_URL`, db/pool.ts:36 (`pglite://<dir>` / `postgres://` / пусто = no-op) | `pglite://<dir>` + предварительно `node infra/migrate.mjs` с тем же URL (сервер миграций сам НЕ гоняет) |
| Идентичность | `hello.token` (identity.ts:23) | случайный UUID-токен = своя партиция userId на общей БД; `dev`/`dev-token` = DEV_USER владельца |
| dev-изоляция | `isDevSession(clientVersion)` (dev-session.ts:21) | назвать клиента `qa-lab`/`cmd-test`/`bench`... |
| LLM | `createGateway` строит `AnthropicLlmProvider`+`SubscriptionLlmProvider` внутри (server.ts:195-227), снаружи не подменяется | in-process: `BrainProviders.llm` (MockLlmProvider, SlowLlm test-support/voice-turn.ts:20); для сервера-процесса — bench: `ctx.agentDeps.llm = new ScriptedLlm` (bench-hub.ts:52); реальный мозг: `JARVIS_SUBSCRIPTION_FALLBACK` не `0` + авторизация подписки |
| STT | `createSttProvider` (providers.ts:22): без `STT_PROVIDER` и без ключа = ЛОКАЛЬНЫЙ Whisper (тяжёлая модель) | `STT_PROVIDER=mock`; in-process `CtrlStt` (voice-turn.ts:48) эмитит финал вручную |
| TTS | `createTtsProvider` (providers.ts:43): без ключей = Mock | mock по умолчанию; кеш TTS `CachingTtsProvider` |
| Расширение | `ExtensionBridge` (extension-bridge.ts:34), `ExtBridgeLike` (ws-routes.ts:42), `ExtSocket` | fake `ExtSocket` (extension-bridge.test.ts), настоящий Chromium+расширение (infra/bench) |
| Время | `Date.now()`/`setTimeout` по всему; параметры `graceMs`, `intervalMs`, `pingTimeoutMs`, `now` у FallbackLlm | vitest fake timers in-process; для процесса-сервера инъекции часов НЕТ |
| Проактив | `JARVIS_AMBIENT_{TELEGRAM,MAIL,CALENDAR}=0`, `JARVIS_SPEAKER_GATE=0`, `JARVIS_SKILL_DISTILL=0`, `JARVIS_FILE_LOG`, `JARVIS_VOICE_FILLER` | env-файл стенда (prepare.mjs:57) |
| MCP | `loadMcpConfig` (brain/mcp/config.ts:146) читает `cwd/mcp.json`, `cwd/../../mcp.json`, `cwd/data/mcp.json` | нет env-выключателя; в `jarvis/mcp.json` есть серверы `think` и `github` — запуск из `apps/server` поднимет их через npx |
| Dev-HTTP | `JARVIS_DEV_HTTP=1` + `JARVIS_DEV_TOKEN` | включать только в лабораторном инстансе, токен обязателен |
| Голосовой ход in-process | `voiceRig` (test-support/voice-turn.ts:73) | настоящие makeSessionContext+VoicePipeline+handleUserText, снаружи STT/TTS/LLM-скрипт |

### Изолированный инстанс рядом с живым (рецепт; собран из кода и bench/prepare.mjs, целиком не запускался)

1. Каталог `L` (ASCII, вне репо): `L/data`, `L/pgdata`.
2. Env-файл `L/server.env`: `PORT=<не 8787, напр. 8811>`, `HOST=127.0.0.1`, `JARVIS_DEV_HTTP=1`, `JARVIS_DEV_TOKEN=<случайный>`,
   `JARVIS_DATA_DIR=L/data`, `DATABASE_URL=pglite://L/pgdata`, `STT_PROVIDER=mock`, `JARVIS_SPEAKER_GATE=0`,
   `JARVIS_AMBIENT_TELEGRAM=0`, `JARVIS_AMBIENT_MAIL=0`, `JARVIS_AMBIENT_CALENDAR=0`, `JARVIS_SKILL_DISTILL=0`,
   `JARVIS_EXT_ID=<id>`; для сценарного/mock-мозга ещё `JARVIS_SUBSCRIPTION_FALLBACK=0`, `ANTHROPIC_API_KEY=`, `CLAUDE_CODE_OAUTH_TOKEN=`
   (пустые значения стенд ставит явно); для РЕАЛЬНОГО мозга SUBSCRIPTION_FALLBACK не задавать (тратит общий лимит подписки).
3. `DATABASE_URL=pglite://L/pgdata node infra/migrate.mjs` (миграции сервер не применяет сам).
4. Запуск: `node --import tsx apps/server/src/index.ts` с `JARVIS_ENV_PATH=L/server.env` и ЧИСТЫМ окружением (без
   унаследованных токенов/прокси), не под супервизором (`infra/supervisor.mjs` держит только боевой).
5. Клиент: `JARVIS_WS_URL=ws://127.0.0.1:<порт>/ws node _jarvis_cmd.mjs "..."` (драйвер поддерживает; порт по умолчанию 8787 —
   молча уводит в БОЕВОЙ сервер), токен — случайный UUID в `JARVIS_CLIENT_TOKEN`.
6. Расширение Chrome зашито на `ws://127.0.0.1:8787/ext` (apps/extension/background.js:28) — рядом с живым сервером
   браузерные руки в лаборатории невозможны, кроме отдельного контейнера (infra/bench, один стенд на контейнер).
7. Не проверено: одновременная работа двух серверов на одной машине (глобальные синглтоны процесса — отдельные процессы, поэтому
   должно быть безопасно; общие с живым остаются только Postgres `DATABASE_URL`, если не переопределён, папка `logs`/`data` при
   запуске без JARVIS_DATA_DIR и `mcp.json`).

## 4. Как проверять без человека

Обозначения: U = юнит/интеграция in-process, S = stand (infra/bench), P = процесс-сервер + WS-драйвер, B = настоящий мозг
(подписка), H = железо/владелец.

| Область | Чем | Есть тесты | Не покрыто |
|---|---|---|---|
| Origin-гард /ws и /ext, пиннинг, 4409 | U (настоящий fastify) | ws-routes.test.ts, ext-channel.test.ts, ext-channel.test.ts (сверка ID с манифестом) | сквозной ws-клиент к запущенному процессу |
| Handshake: H7-порядок | U | handshake-h7.test.ts | version_mismatch (4002), unauthorized (4001/4003), таймаут handshake, resume через doHandshake, реплей буфера в onConnection — тестов НЕТ (grep по 4001/4002/4003/version_mismatch пуст) |
| PreHandshakeBuffer политика | U | pre-handshake-buffer.test.ts (чистая политика) | проводка буфера в onConnection (реплей в порядке, WARN о потере) |
| Identity/strict | U (PGlite) | identity.test.ts, db/users.test.ts | — |
| Registry resume/grace | U (fake timers) | registry.test.ts | связка grace + onConnection close |
| Session sendAction/confirm/teardown | U | session.test.ts | — |
| Heartbeat | U косвенно | (нет своего теста heartbeat.ts) | onDead-разрыв, pong-сброс |
| task-control, killswitch, W0-рефлексы | U | router-ws.test.ts (25), task-control-speech.test.ts | эффект на реальный VoicePipeline барж-ина |
| Голосовой ход | U (voiceRig) | first-answer-wiring, speak-result-delivery, promote-ack-prewarm, wake-rescue-wiring | реальный STT/аудио — H или audio-replay через Deepgram/Whisper (не сделано) |
| client.selection/env/settings | U | selection-wiring.test.ts, app-channels-wiring.test.ts | client.settings/keys/usage/memory.* — тестов в gateway нет (не проверено по grep) |
| Мост расширения | U (fake sock) | extension-bridge.test.ts, ext-absence*.test.ts | реальный Chromium — S |
| Dev-HTTP гейтинг | U (app.inject) | bench/bench-gating.test.ts, bench-routes.test.ts | /dev/action, /dev/say, /dev/vad, /ext/* — тестов нет |
| Boot createGateway/listen/close | P | smoke-async.ts (ручной скрипт, порт 8791, НЕ в vitest, пишет в cwd/data; актуальность не проверена) | close(), bind-гард в реальном listen |
| Реальный мозг | B | — | нужна подписка и лимиты; см. labRequirements |

## 5. Дефекты и долг

| # | Серьёзность | Где | Суть |
|---|---|---|---|
| D1 | med | router-ws.ts:1055-1108, 1201 | Dev-сессия (по clientVersion) не изолирована на записи в данные пользователя: `client.settings` (setLanguage/setContext), `client.keys` (setCredential), `memory.forget`, `voice.remove`, `demo.save` идут в userId без проверки devSession. Драйвер с токеном `dev` (DEV_USER = владелец) при таком кадре на ЖИВОМ сервере меняет данные владельца. На изолированном инстансе не страшно. |
| D2 | med | server.ts:397-403 | Dev-роуты (`/dev/action` исполняет ActionCommand в обход §14) без проверки Host/Origin и при пустом `JARVIS_DEV_TOKEN` защищены только loopback-IP. DNS-rebinding возможен. Живой `.env` флаг не включает (по grep ключей), но лабораторный инстанс включает — токен обязателен. |
| D3 | med | server.ts:865 | `void dispatch(ctx, env)` без очереди; комментарий говорит «упорядоченная обработка». Два `dev.text` подряд идут параллельными ходами; `client.system` с `await tabList` обгоняется. Драйвер обходит это паузой 11 с (`_jarvis_cmd.mjs:STEP_MS`). Для лаборатории — недетерминизм при быстрой отправке. |
| D4 | med | server.ts:816-820 | После hello таймер handshake снят, верхней границы на `doHandshake` нет: зависший `loadProfile`/`spend.hydrate` держит сокет без закрытия и без heartbeat; буфер лишь ограничен по размеру. Не проверено, есть ли таймауты у всех вызовов БД (у pg-пула есть). |
| D5 | low | dev-session.ts:22 | Регэксп по подстроке `test|qa|cmd|script...` в clientVersion: будущая версия настоящего клиента вроде `1.2.0-latest`/`...-qa` молча станет dev-сессией (без напоминаний/ambient/чекпойнтов); и наоборот любой клиент может назваться dev. |
| D6 | low | server.ts:723, 119 | Модульные глобалы `liveCtxs`, `gatewayBackstopInstalled`: несколько `createGateway` в одном процессе (тесты) делят liveCtxs; `/dev/say` может попасть в чужую сессию. |
| D7 | low | server.ts:531-551 | `/healthz`, `/stats`, `/cogs` без гарда (loopback-only bind, но `/cogs` отдаёт расход per-user). |
| D8 | low | router-ws.ts (1318 строк), server.ts (1167), `makeSessionContext` ~550 строк, `createGateway` ~590 строк | Нарушение закона «модули < 150 строк» (старые файлы без запроса не рефакторятся по глобальному правилу). Усложняет тестирование швов (нет DI для LLM/STT/TTS в createGateway). |
| D9 | low | packages/protocol/src/messages.ts:53,55 | `proactive.nudge` и `screen.capture.request` объявлены, сервером не отправляются (grep пуст); `screen.capture.result` — обработчик-заглушка TODO(M2) (router-ws.ts:1136); `demo.event` только лог; `handleTakeover` — no-op с неиспользуемыми аргументами. Мёртвая поверхность протокола. |
| D10 | low | task-control.ts:13,15 | Два отдельных импорта из одного модуля `../brain/router/index.js`. Косметика. |
| D11 | low | server.ts:284-288 | Ambient-источники привязаны к `DEV_USER` (а не к userId сессии); клиент с UUID-токеном ambient не получает. Для лаборатории — плюс (изоляция), для мультитенанта — долг. |
| D12 | low | smoke-async.ts | Ручной смоук вне vitest, порт 8791, пишет в `cwd/data`, не задаёт JARVIS_DATA_DIR; актуальность (tier0 «открой ютуб» и т.п.) не проверена. |
| D13 | low | brain/mcp/config.ts:146 | Нет выключателя MCP: изолированный сервер при cwd в репо поднимает MCP из `jarvis/mcp.json` (npx, github) — побочные эффекты и трафик. |

## 6. Что лаборатория обязана уметь ради этой подсистемы

Смотри `labRequirements` в JSON. Главное: (1) поднимать изолированный инстанс по рецепту раздела 3 одной командой и гасить
только свои процессы; (2) DI-точка в `createGateway` для LLM/STT/TTS/часов (сейчас только через bench-сессию или in-process
`BrainProviders`); (3) лабораторный WS-клиент, реализующий контракт «настоящего клиента» (hello, pong, action.result по
сценарию, confirm по политике, честный отказ на неподдерживаемые действия), с dev-именем; (4) тесты сквозного onConnection
по реальному ws: version_mismatch, timeout, resume, реплей буфера, heartbeat-разрыв; (5) fake-часы для процесса-сервера или
параметризация таймеров env.
