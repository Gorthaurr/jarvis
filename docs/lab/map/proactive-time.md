# Карта лаборатории: proactive-time (всё, что запускается временем/событием без реплики владельца)

Область: `apps/server/src/proactive/*`, `apps/server/src/autonomy/*`, очередь озвучки `voice/pipeline.ts` (speakQueued), проводка в `gateway/router-ws.ts` и `gateway/server.ts`. Пути ниже даны от `apps/server/src/`. Исходники не правились, ничего не запускалось.

## 1. Как работает

### 1.1 Сквозной поток

```
источник (время / вкладка / стор / первая реплика владельца)
   -> сервис (Reminder / Watch / Ambient / router-ws flush*)
   -> гейты: killswitch (freeze) -> throttle (только LLM) -> занят? -> тихие часы (только ambient)
   -> speak(text[, urgent], onOutcome)  = VoicePipeline.speakQueued(verbalize(text), urgent, {retriable:true, onOutcome})
   -> очередь озвучки (QUEUE_MAX=4, TTL 120с; retriable не вытесняется, новой отказывают -> false)
   -> onOutcome(spoken) : true = "done/seen/pendingNotify снят", false = откат, реплика ждёт снова
```

Главный инвариант (закон честности, "принято != прозвучало"): durable-статус (`done`, `seen`, `pendingNotify=undefined`) ставится только когда очередь приняла реплику, и ОТКАТЫВАЕТСЯ колбэком `onOutcome(false)` при TTL/"стоп"/смерти сессии (reminders/service.ts:287-319, watch/service.ts:356-391, ambient/engine.ts:201-222). Отказ очереди (`speak(...) === false`) равен "нет сессии": запись остаётся недоставленной, взводится drain-таймер 20 с.

### 1.2 Ключевые файлы

| Файл | Роль |
|---|---|
| `proactive/reminders/reminder.ts` | чистая логика: `resolveFireAt`:253, `parseRepeat`:123, `nextFireAfter`:151 (DST через `setDate`), `sameSeriesSlot`:183, `seriesCoversMoment`:216, `sameReminderSubject`:301 |
| `proactive/reminders/store.ts` | `data/reminders.json`, атомарно tmp->rename, цепочка записей, `awaitingDelivery` по userId |
| `proactive/reminders/service.ts` | `ReminderService`: один таймер next-wakeup (`reschedule`:417, `tick`:409), `catchUp`:427, `flushPending`:379 (порция 2, дренаж 20 с), серии `scheduleNextOccurrence`:336, `add`:85 (три уровня дедупа) |
| `proactive/watch/watch.ts` + `store.ts` + `service.ts` + `checker.ts` | наблюдения: `dueAt`:153, `watchActionFingerprint`:169, `tickNow`:617, `runCheck`:659, `notify`:356, `dispatchAction`:482, `flushPendingActions`:520, LLM-проверяльщик `createWatchChecker`:69 |
| `proactive/ambient/engine.ts` | `AmbientEngine`: `setInterval` 90 с (`start`:76), `tickNow`:119, `consider`:159, `flushPending`:241 |
| `proactive/ambient/{obligations,telegram-source,calendar-source,calendar-parse,mail-source}.ts` | источники сигналов (чистые функции `*Signal` + фабрики `create*Source`) |
| `proactive/ambient/store.ts` | `data/ambient-seen.json`, TTL ключа 14 дней, `mark/unmark` |
| `proactive/quiet-hours.ts` | окно `JARVIS_QUIET_HOURS` ("23-9" / "23:30-08:15"), деф ВЫКЛ |
| `proactive/incidents.ts` | читает `incidents.jsonl` (пишет супервизор), маркер `incidents-reported.json`, окно 24 ч |
| `proactive/briefing.ts`, `self-review.ts`, `greeting.ts` | чистые сборщики фраз; вызываются из router-ws/server.ts |
| `proactive/consolidation.ts` + `consolidation-journal.ts` | сон-цикл памяти |
| `autonomy/freeze.ts` | killswitch-латч `autonomy-freeze.json`, fail-closed, команды `matchAutonomyCommand`:109 |
| `autonomy/throttle.ts` | скользящий лимит 120 автономных LLM-вызовов/час (`JARVIS_AUTONOMOUS_LLM_PER_HOUR`, 0 = выкл) |
| `gateway/router-ws.ts` | проводка: регистрация speakers:795-846, `flushIncidentReport`:516, `flushDailyBriefing`:542, `flushSelfReview`:612, `onOwnerPresent`:648 |
| `gateway/server.ts` | сборка сервисов:282-321, старт:577-607, `maybeConsolidate`:1027, `startOnboarding`:1066 |
| `gateway/task-control.ts` | голосовые "полный стоп"/"включи автономию":96-131 |

Не подключены к рантайму (см. дефекты): `proactive/hub.ts`, `scheduler.ts`, `presence.ts`, `triggers/index.ts`, `salience.shouldInterrupt/NudgeQueue`.

### 1.3 Часы и таймеры (где берётся время)

| Механизм | Тип | Значения |
|---|---|---|
| ReminderService.timer | одиночный `setTimeout` до ближайшего `fireAt`, потолок 2^31-1 мс, `unref` | перепланируется в `add/cancel/tick` |
| ReminderService.drainTimer / WatchService.drainTimer | `setTimeout` 20 с | добивание недоставленных порцией по 2 |
| WatchService.timer | одиночный `setTimeout` до ближайшего `dueAt`; при killswitch пере-взвод каждые 30 с (`FREEZE_RECHECK_MS`) | интервалы: LLM деф 300 с (мин 30 с), предикат деф 10 с (мин 5 с) |
| AmbientEngine.timer | `setInterval` 90 с (`JARVIS_AMBIENT_INTERVAL_MS`), первый тик сразу в `start()` | re-entrancy-гард `ticking` |
| Все "сейчас" | `opts.now ?? Date.now` | инъекция есть у Reminder/Watch/Ambient/Throttle/источников; сами таймеры глобальные |
| Прочее | `Date.now()`/`new Date()` без DI: greeting.timeOfDay, consolidation, recordIncident, flush* в router-ws | подменяются только глобальными fake timers / setSystemTime |

Фейковое время сегодня: `vi.useFakeTimers()` в `proactive/reminders/service.test.ts` и `proactive/watch/service.test.ts`; остальные тесты гоняют чистые функции с числом `now`.

### 1.4 Состояния

- Reminder: `scheduled` (+`firedAt` = сработало, ждёт доставки) -> `done` | `cancelled`. Серия: каждое срабатывание порождает новую запись с общим `seriesId`; недоставленные экземпляры серии схлопываются (service.ts:345).
- Watch: `active` -> `fired` (one-shot) | `cancelled` | `suspended` (dead-watch после 10 провалов подряд, либо подмена отпечатка действия). Поля: `metStreak` (edge-триггер действия), `pendingNotify`, `pendingAction(+At)`, `lastOkAt/blindNotifiedAt`, `sawFreshAt` (gsi gone).
- Ambient: `seen` (durable, откат при неозвучке) + `queuedKeys` (в процессе) + `pending` (владелец офлайн, в ОЗУ).
- Freeze: `null | {frozenAt, reason}`; битый файл = стоп стоит.

### 1.5 Законы и инварианты

1. Честность исхода: доставка помечается по факту звука; отказ очереди = недоставлено; "нет данных" у чекера/сенсора = транзиентная ошибка, а не `met:false` (иначе сбросится `metStreak` и действие сработает повторно).
2. Killswitch замораживает ТОЛЬКО автономию: watch-тики, ambient, авто-предиктор, сон-цикл, рефлексы памяти/обязательств, доставку watch-уведомлений и запуск поручений. НЕ замораживает: напоминания (заказаны на время), ходы владельца.
3. Доставка только владельцу: ищется точная сессия, затем любая сессия ТОГО ЖЕ userId (переподключение), никогда чужая (§6B/B3).
4. Dev/bench-сессия не получатель: не регистрирует speakers/actions/runner, не потребляет маркеры (инциденты, брифинг, сон-цикл, приветствие) — иначе прогон драйвера "съест" ночные события владельца.
5. Не в пустую комнату: инциденты/брифинг/самоосмотр триггерятся первой репликой владельца (`onOwnerPresent`), не коннектом, и не при `ownerBusy()` (гейт не тратится).
6. Действие watch исполняется по отпечатку одобренных `what|condition|action|predicate` (без `tabId/url`), на ПЕРЕХОДЕ not-met -> met, поручение с TTL 30 мин; ввод в петлю только из доверенных полей, наблюдённое значение не подмешивается (анти-инъекция).
7. Антиспам: порция 2 при флаше, бюджет 2 несрочных на тик ambient, срочное (счёт в день оплаты) проходит всегда, time-anchored сигналы (`ttlMs`) не держатся тихими часами.

### 1.6 Как не допустить дубля озвучки при втором экземпляре сервера

Что есть:
- `infra/supervisor.mjs:17,98-117` PID-лок `infra/supervisor.lock` (вторая копия супервизора выходит); при живом `/healthz` супервизор уходит в режим наблюдателя и второй сервер не поднимает (`startServerInner`:239).
- Порт 8787: `app.listen` падает, `index.ts` завершает процесс с кодом 1.
- Озвучка идёт только через WS-сессию клиента: сервер без подключённого клиента ничего не говорит, просто накапливает `awaitingDelivery`/`pendingNotify`.

Чего нет: файловых блокировок state-файлов (`reminders.json`, `watches.json`, `ambient-seen.json`, `obligations.json`: перезапись целиком, last-writer-wins) и порядка "сначала bind, потом start": `reminders.start()`:577, `watch.start()`:605, `ambient.start()`:607 идут ДО `app.listen`:669. Проигравший экземпляр успевает изменить `reminders.json` и запустить тик. Лаборатория обязана это воспроизвести (дефект D1).

## 2. Возможности (capabilities)

Полный список с `entry`/`needs`/`testedBy` в `proactive-time.json`. Кратко (id: вход, триггер):

| id | Что делает | Вход | Триггер |
|---|---|---|---|
| reminder.set | set_reminder: delay_seconds или at, повтор daily/weekdays/weekly/repeat_seconds>=60 | brain/tools/handlers/reminders.ts:9 | tool |
| reminder.dedup | дубль (текст+fireAt в 15 с), одно дело (окно 2 ч), вторая серия, серия/разовое на слоте | reminders/service.ts:85 | tool |
| reminder.cancel-list | cancel по id/фрагменту с фильтром владельца, отмена всей серии; list | reminders/service.ts:217 | tool |
| reminder.fire | таймер -> deliver: urgent+retriable | reminders/service.ts:409 | time |
| reminder.repeat-series | следующий слот, без пачки пропущенных | reminders/service.ts:336 | time |
| reminder.catchup-grace | при старте: просрочка >6 ч пропускается, серия продолжается | reminders/service.ts:427 | event |
| reminder.deferred-delivery | flush порциями при подключении | reminders/service.ts:379 | event |
| reminder.commitment-reflex | "завтра надо позвонить маме" -> LLM -> set_reminder + реплика | brain/agent/commitment-reflect.ts:103 | voice |
| watch.create / cancel-list | watch_create (+action с confirm §14), watch_cancel, watch_list | brain/tools/handlers/watch.ts:81 | tool |
| watch.llm-check | LLM+web_search/web_fetch+report на sonnet | watch/checker.ts:69 | time |
| watch.predicate-client | wait.for на клиенте, gsi-gone по sawFreshAt | watch/service.ts:268 | time |
| watch.browser-probe | предикат kind=browser через ext-мост, self-heal вкладки | gateway/server.ts:580 | time |
| watch.tick-notify | параллельные проверки, one-shot/continuous, антидребезг | watch/service.ts:617 | time |
| watch.action-reentry | реэнтри в `handleUserText(origin=watch-action)` | watch/service.ts:482, router-ws.ts:824 | event |
| watch.action-approval | отпечаток + TTL поручения | watch/service.ts:460,520 | event |
| watch.dead-and-blind | suspend после N провалов; одноразовое "не могу наблюдать" через max(6 ч, 20*интервал) | watch/service.ts:400,696 | time |
| obligation.tools | obligation_add/remove/list | brain/tools/handlers/obligations.ts:14 | tool |
| ambient.engine | опрос, дедуп, салиентность>=0.5, сортировка urgent+salience | ambient/engine.ts:119 | time |
| ambient.obligations | soon за 2 дня (0.6), в день оплаты urgent (0.95) | ambient/obligations.ts:134 | time |
| ambient.telegram / calendar / mail | сигналы из УЖЕ открытых вкладок; нет вкладки = молчим; деградации в metrics | ambient/*-source.ts | time |
| ambient.quiet-hours | глушит несрочный ambient без ttl | proactive/quiet-hours.ts:31 | time |
| incident.report | сводка сбоев (голос + чат), маркер по факту доклада | router-ws.ts:516 | voice |
| briefing.daily | встречи/напоминания/сроки/наблюдения, раз в календарный день | router-ws.ts:542 | voice |
| selfreview.weaknesses | раз в 3 дня, слабости count>=3 | router-ws.ts:612 | voice |
| consolidation.sleep-cycle | раз в день, до 5 фактов, отсев директив, журнал | gateway/server.ts:1027 | event |
| greeting.onboarding | опенер haiku, отсев "я проверил", кулдаун 6 ч | proactive/greeting.ts:93 | event |
| autonomy.killswitch | латч-файл; ack честно говорит про durable | autonomy/freeze.ts:27, gateway/task-control.ts:96 | voice |
| autonomy.throttle | 120 LLM/час, отказ = транзиент | autonomy/throttle.ts:142 | time |
| speech.queue | общая очередь озвучки | voice/pipeline.ts:700 | event |
| trading.auto-predictor-tick | соседний потребитель freeze/throttle | brain/trading/auto-predictor.ts:197 | time |
| liveOnly x3 | реальные DOM-ридеры вкладок; слышимая озвучка; дрейф таймеров после сна ПК | см. json | owner/hardware |

Итого 36 возможностей, 3 liveOnly.

## 3. Швы (seams) и как подменить

| Шов | Где | Как в лаборатории |
|---|---|---|
| Часы | `opts.now` (reminders/service.ts:37, watch/service.ts:38, ambient/engine.ts:22, throttle.ts:148, источники) | передавать функцию; таймеры — `vi.useFakeTimers()` (мокает и `Date`), иначе нужен Clock/Scheduler-шов |
| Часы без DI | greeting.ts:27, consolidation.ts, incidents.ts:45, router-ws.ts flush* | `vi.setSystemTime` |
| Канал озвучки | `registerSpeaker` (reminders/service.ts:248, watch/service.ts:208, ambient/engine.ts:99) | фейк, пишущий реплики; варианты: вернуть `false`, вызвать `onOutcome(false)` |
| Клиент для предикатов | `registerActions` (watch/service.ts:237) | фейк `wait.for` с `{ok,data:{met,unknown,gsiState}}` |
| Зонд браузера | `setBrowserProbe` (watch/service.ts:247) | фейк `BrowserProbeResult` |
| Запускатель петли | `registerRunner` (watch/service.ts:223) | фейк, пишущий goal; реальный путь — router-ws.ts:824 |
| Чекер/LLM | `WatchService(checker)`; `ILlmProvider`; `IWebProvider` | `gateway/bench/scripted-llm.ts`, стаб web |
| Ридеры вкладок | `CalendarReader/MailReader/TelegramUnreadReader` | фикстуры: noTab, blank, ok:false, нераспознанные чипы, события |
| Источники ambient | `AmbientSource {id,label,enabled,poll}` | любой фейк |
| Данные | `JARVIS_DATA_DIR` + конструкторы сторов `(dataDir)` | временная папка на прогон |
| Синглтоны | `setAutonomyFreezeForTests`, `setAutonomyThrottleForTests` | сбрасывать между сценариями |
| Профиль-гейты | `brain/profile.ts:161` (`lastBriefedAt/lastSelfReviewedAt/lastConsolidatedAt`) | через тот же data-каталог |
| Dev-сессия | `isDevSession` (router-ws.ts:503) | для проводки нужен не-dev фейковый клиент (версия не dev/bench) |
| Занятость | `ownerBusy` (router-ws.ts:512) из `client.context` | фейк-клиент шлёт `micBusyByOtherApp/fullscreen/locked` |
| Очередь озвучки | `createVoicePipeline` deps (tts, now) | фейк TTS; `JARVIS_SPEECH_QUEUE_TTL_MS/MAX` |
| Bench | `gateway/bench/*`, `infra/bench` | bench = dev-сессия, ambient выключен, управления временем нет; сценарии нужно добавить |

## 4. Как проверять без человека

Условные обозначения: U = достаточно юнит/интеграционного теста; FC = фейковые часы; FL = скриптованный LLM; RB = настоящий мозг (подписка); CH = Chromium+расширение (bench); LIVE = только с железом/владельцем.

| Возможность | Уровень | Тесты (от `apps/server/src/`) | Чем НЕ покрыто |
|---|---|---|---|
| reminder.* | U + FC | `proactive/reminders/{reminder,service,store}.test.ts`, `brain/tools/handlers/reminders.test.ts` | реальная очередь озвучки (только фейк-speaker); DST (нужна TZ с переходом); сон ПК; два экземпляра на одном каталоге |
| reminder.commitment-reflex | U + FL, живой смоук с RB | `brain/agent/commitment-reflect.test.ts` | качество извлечения срока живой моделью; проводка через `handleUserText` |
| watch.create/cancel/tick/action/dead/blind | U + FC | `proactive/watch/{service,checker,predicate}.test.ts`, `brain/tools/handlers/watch.test.ts` | реальный wait.for клиента; реальный ext-мост (browser probe); реэнтри именно через петлю router-ws |
| watch.llm-check | U + FL; качество вердикта только RB | `proactive/watch/checker.test.ts` | реальный веб, качество unknown/met у модели, prompt-инъекция живой моделью |
| ambient.engine + источники | U + FC | `proactive/ambient/*.test.ts`, `proactive/quiet-hours.test.ts` | проводка router-ws:841 (isBusy, registerSpeaker); реальные DOM-чипы (LIVE) |
| incident.report | U (чистые части) | `proactive/incidents.test.ts` | сама проводка `flushIncidentReport` (нет теста: grep по `flushIncidentReport` находит только router-ws/server) |
| briefing.daily | U | `proactive/briefing.test.ts` | проводка `flushDailyBriefing` (гейт дня, ownerBusy, `channelUp`), чтение календаря |
| selfreview | U | `proactive/self-review.test.ts` | проводка `flushSelfReview`, `collectWeaknesses` на реальных логах |
| consolidation | U + FL | `proactive/consolidation{,-journal}.test.ts` | `maybeConsolidate` (server.ts:1027) без теста; реальная БД + LLM |
| greeting | U + FL | `proactive/greeting.test.ts` | `startOnboarding` кулдаун/восстановленная память |
| killswitch | U | `autonomy/freeze.test.ts`, `gateway/task-control-speech.test.ts` | сквозной: freeze посреди тика -> разморозка -> `watch.tickNow` (частично в watch/service.test.ts) |
| throttle | U + FC | `autonomy/throttle.test.ts` | сквозное срабатывание в реальных потребителях |
| speech.queue | U | `voice/pipeline.test.ts` | взаимодействие трёх сервисов на общую очередь при "ночь офлайна" (реальный залп) |
| liveOnly: DOM-ридеры, слышимая озвучка, сон ПК | LIVE | нет | всё |

Общий пробел: ни один тест не гоняет ПРОВОДКУ целиком (`createGateway` -> не-dev WS-сессия -> реальные сервисы -> реальный VoicePipeline с фейком TTS). Урок проекта ("дыры живут в проводке") здесь не закрыт: проводка флашей в router-ws и `maybeConsolidate` без тестов.

## 5. Дефекты и долг

| # | Серьёзность | Где | Что |
|---|---|---|---|
| D1 | med | `gateway/server.ts:577,605,607` vs `:669` | сервисы стартуют ДО bind порта: проигравший второй экземпляр правит `reminders.json`, взводит таймеры и ambient-тик, потом `exit(1)`. Нет файловых блокировок state-файлов |
| D2 | med | `proactive/reminders/store.ts:346` (и watch/ambient/obligations `load`) | битый JSON -> `items=[]`, следующий `persist` стирает файл без бэкапа; ENOENT и ошибка разбора не различаются |
| D3 | low | `proactive/hub.ts`, `scheduler.ts`, `presence.ts`, `triggers/index.ts`, `salience.ts:44,93` | мёртвый код; `salience.test.ts` зелёный на неподключённом коде; `lastContextBySession` пишется (router-ws.ts:954) и не читается |
| D4 | low | `proactive/salience.ts:64` vs `router-ws.ts:512` | две версии "занятости" с разными порогами |
| D5 | low | `gateway/server.ts:282` | у `AmbientEngine` не передан `phraser` — LLM-фразировка в проде выключена, опция только для тестов |
| D6 | low | `proactive/ambient/engine.ts:68` | тихие часы не касаются watch/напоминаний (все urgent) — уточнить политику |
| D7 | low | `proactive/reminders/service.ts:409` | нет возрастного лимита в рантайме: после сна ПК напоминание "на 9:00" прозвучит в 17:00 (grace лишь при старте) |
| D8 | low | `proactive/greeting.ts:27,97`, `consolidation.ts`, `incidents.ts:45` | нет DI часов; лаборатория обязана использовать глобальные fake timers |
| D9 | low | `proactive/ambient/obligations.ts:94` | `cancel` по id без фильтра userId (в reminders/watch уже закрыто) |
| D10 | low | `brain/tools/handlers/obligations.ts:20` | `Date.parse("YYYY-MM-DD")` = UTC-полночь при локальной математике; разовые обязательства не чистятся |
| D11 | low | `gateway/server.ts:284-288` | telegram/calendar/mail-источники привязаны к `DEV_USER` |
| D12 | low | `gateway/router-ws.ts:542` | гейт брифинга в замыкании соединения + метка после await: два соединения владельца могут озвучить сводку дважды |
| D13 | low | `gateway/server.ts:1053` | `setLastConsolidated` + `claim` до запуска LLM: сбой сжигает дневной слот |
| D14 | low | `autonomy/freeze.ts:35` | кэш `info()` бессрочный: ручное удаление латч-файла на работающем сервере не размораживает (по замыслу, но неочевидно) |

Не проверено чтением: SSRF-защита `IWebProvider` внутри watch-чекера (`deps.web.fetch` берёт URL от модели), логика `mail-source.ts` после строки 120 и `calendar-parse.ts`, `collectWeaknesses`, поведение `auto-predictor` кроме гейтов.

## 6. Что лаборатория обязана уметь ради этой подсистемы

1. In-process harness: сервисы на временном `JARVIS_DATA_DIR`, глобальные fake timers, фейк-speaker с режимами accept / reject(false) / outcome(false).
2. Не-dev фейковый WS-клиент (версия не dev/bench) с `client.context`, чтобы работали регистрации speakers/runner/actions и `onOwnerPresent` (инциденты, брифинг, самоосмотр), приветствие и сон-цикл.
3. Управление временем на стенде: dev-маршрут "advance/tick" или запуск сервера под fake-time; сейчас bench выключает ambient и не умеет ни времени, ни тиков.
4. Фикстуры вкладок (календарь/почта/Telegram: noTab, blank, нераспознанная разметка, нормальные события) и фейки PredicateSender/browserProbe.
5. Сценарии перезапуска и двух экземпляров на одном каталоге (catchUp, grace, pendingNotify/pendingAction, TTL, D1/D2).
6. TZ-матрица с переходом на летнее время; локальные полночь/будни.
7. Скриптованный LLM для checker/consolidation/greeting/commitment-reflect + режим настоящего мозга по подписке для проверки формулировок; сброс синглтонов freeze/throttle между сценариями.
8. Реальный `VoicePipeline` с фейковым TTS для общей очереди (QUEUE_MAX, TTL, стоп, смерть сессии) и проверка откатов `done`/`pendingNotify`/`seen`.
