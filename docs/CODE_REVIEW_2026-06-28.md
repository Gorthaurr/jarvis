# Полный код-ревью Jarvis — 2026-06-28

Аудит всего кодбейза (163 файла, 33.5К строк) веером по 11 областям × 4 измерения (ООП/SRP, архитектура,
мёртвый код, дубли/DRY), каждая находка прошла адверсариал-верификацию (перечтение реального кода, отсев ложных).

**Итог: 74 подтверждённых находки — 8 high / 23 medium / 43 low.**

## Общая оценка (что ХОРОШО)
- **Честность по ошибкам соблюдена** — нигде нет ложного «готово» в актуаторах (кроме явных стабов ниже); verify-loop, error-voice, anti-runaway на месте.
- **Нет хардкода сценариев** — концепция «мощные общие инструменты» выдержана.
- **Чистые ядра:** trading, memory/tasks, gateway/db, billing/obs, protocol/shared, voice-pipeline — SRP, инъекция зависимостей, тестируемость в порядке.
- Проблемы сконцентрированы в нескольких **god-объектах** + **мёртвом коде** + **дублях**, а не размазаны.

---

## HIGH (8)

### Функциональный БАГ
1. **`tools/dispatch.ts:360` — `marketField()` молча отбрасывает `market:"tinkoff"`** (и любое значение вне 4 крипто/moex) → `market_quote/candles/analyze` зовут `inferMarket(symbol)` → данные Тинькофф уходят на MOEX/crypto БЕЗ ошибки. Расходится со схемой и типом `Market`. **Фикс:** включить `tinkoff` в allowlist (и в `tradePredict`), либо единый валидатор рынка рядом с типом.

### God-объект (ядро)
2. **`agent/index.ts:469-1204` — `runAgentLoop` ≈735 строк**, смешивает ~10 ответственностей (тир/эскалация, prompt-кеш, retrieval+recall, сборка промпта+инструментов, стриминг, 3×anti-runaway, verify-петля, анти-капитуляция, докрутка вывода, телеметрия, фон-задачи, самообучение). Прямое нарушение стандарта SRP. **Фикс:** выделить TierEscalator/RunawayGuard/VerifyTracker/CapitulationGuard/OutputContinuation/TaskTelemetry; петля оркеструет.

### «Лгущие» инструменты (нарушение «инструмент не врёт»)
3. **`message_send` (Telegram) гарантированно проваливается.** Боевой путь — `telegram_send` (off-screen Chrome+CDP, реально шлёт). Параллельный `message_send`→`@jarvis/userbots TelegramSender` структурно НЕ может доставить (`send()`→`{ok:false,'GramJS — TODO(M6)'}`). Модели дан инструмент, который всегда врёт провалом. **Фикс:** убрать telegram из `message_send`/каталога (оставить userbots под VK), пока GramJS не реализован.
4. **`actuators/messaging.ts:20` — `configureSenders()` нигде не вызывается** → registry всегда `MockSender(ready=false)` → весь реальный userbot-путь мёртв. Связано с #3. **Фикс:** удалить `messaging.ts` + зависимость (честный канал уже есть через `telegram_send`), либо честно пометить «не готово».

### Дубли инфраструктуры (DRY)
5. **`deepgram.ts:159-465 vs 539-957` — два WS-класса STT** (legacy per-utterance + persistent) дублируют почти всю WS-механику (`shouldReconnect` побайтно идентичен, backoff, keepAlive, парсинг Results). **Фикс:** общий `deepgram-socket.ts` (reconnect+backoff+keepAlive+parse), классы-наследники.
6. **`jarvis-browser.ts` ↔ `browser-cdp.ts` — дубль мини-CDP-клиента:** `getFreePort` дословно дважды, `WsLike`, `CdpConn`≈`CdpBrowserController` (connect/send+pending-Map+timeout/evaluate). **Фикс:** общий `actuators/cdp-core.ts`.
7. **`packages/shared/ui-match.ts` — `bestTextMatch` МЁРТВ** (зовётся только тестом), а боевой клик в `extension/background.js` переизобретает ту же логику сырым `.includes()` — ровно баг ложных подстрок, ради которого ui-match и писали. **Фикс:** протянуть ui-match в реальный путь клика расширения, либо удалить.

---

## MEDIUM (23) — сгруппировано

### God-объекты (смешение ответственностей, против стандарта <150/SRP)
- **`dispatch.ts` (1276)** — ~40 хендлеров 5 несвязанных доменов (трейдинг/браузер/telegram/навыки/напоминания) + диспетчер. → разнести по `tools/handlers/*.ts`, оставить switch+гарды.
- **`memory/skills.ts` (1001)** — парсер/сериализатор/CRUD+мультитенант/лексич.recall/семантич.recall+кэш/provider+дистилляция. → `skill-parse/skill-store/skill-recall/skill-provider`.
- **`router-ws.ts` (831)** — интерфейсы провайдеров + `makeSessionContext` + dispatch ~18 типов + task-control + enroll. → вынести session-context/task-control/enroll-handler.
- **`jarvis-browser.ts` (757)** — процесс Chrome + CDP-протокол + веб-движок + Telegram-навык (4 ответственности). → ChromeProcess/CdpConn(в cdp-core)/JarvisWebEngine/TelegramSkill.
- **`extension/background.js` (1353)** — WS-транспорт + вкладки + media/click + полный Telegram-сценарий + cookies. → ES-модули (MV3 type:module).
- `agent/index.ts:1307` — `successPhrase/failurePhrase` (презентация tier0) в файле ядра. → `verbalize/action-phrases.ts`.

### Мёртвый код
- **`integrations/{calendar,maps,geofence}.ts`** — НИ ОДИН модуль не импортирует (проактивный слой-стаб не подключён). → удалить кластер или подключить.
- **`actuators/browser.ts:47` — `placeOrder` возвращает ФЕЙКОВЫЙ успех** `{orderId:'stub-order-…'}` (order_place в EXCLUDED_TOOLS, не зовётся). → удалить или честный `throw not_implemented`.
- **`db/credentials.ts:37` — путь ЧТЕНИЯ per-user ключей не вызывается** (setCredential пишет+логирует успех, getCredential/resolveUserKey мёртвы) — риск ложного «сохранено». → довести проводку или честный UI-фидбэк.
- **`tasks/narrate.ts`** — 5 экспортов (announceTask/shouldAnnounce/milestoneLine/finalReport/errorReport) только в тесте. → подключить §20-нарратив или удалить.
- **`trading/sim.ts`** — бэктест-движок не зовётся прод-кодом (только sweep-раннер+тест). *Осознанно: аналитический движок, не прод-инструмент; можно подключить к `market_backtest`.*
- `actuators/messaging.ts`, `case order.place` — см. HIGH.

### Дубли/DRY
- **`yandex-tts.ts` ↔ `elevenlabs.ts`** — ~90% «HTTP one-shot mp3 → один TtsChunk» (таймаут/abort/cancel/колбэки идентичны). → базовый `OneShotHttpTtsStream`, провайдеры реализуют `fetchAudio`.
- **`normalize()` побайтово в `tasks/scope.ts:20` + `tasks/control.ts:43`** (+ ядро в `knowledge/index.ts:59`). → единая `foldText` в `@jarvis/shared`.
- **`skills.ts:55` — `slugify` держит свою таблицу транслита кириллицы**, хотя в `@jarvis/shared/name-match` есть `transliterate`/`RU2LAT`. → переиспользовать.
- `deepgram.ts:867` backoff-формула дублируется (есть `backoffMs` в shared); страничный act-script дублируется (jarvis-browser ↔ browser-cdp); `background.js` helpers (visible/realClick/setInput) ×3; `tier0` громкость (SendKeys без readback) расходится с `system.ts` (Core Audio + сверка).

---

## RENDERER (отдельный прогон, 6: 0 high / 4 med / 2 low)
- **`renderer.ts` (811) — god-модуль:** ~12 UI-подсистем плоско, module-level стейт, без под-контроллеров. → разнести (orb-state/cards/settings-panel/skills-panel/…).
- **Дубль построения строки списка** (навыки/голоса/мониторы) — против стандарта единых UI-компонентов. → общий `listRow()`.
- **Мёртвый `AnalyserNode`** в `audio.ts` (создаётся/коннектится, но уровень микрофона нигде не читается; волна — чистая CSS-анимация, комментарии лгут). → удалить или привязать волну к реальному уровню.
- `currentState` write-only; `$()` бросает на module-load (рассинхрон id → белый экран); дубль setOrbState.

---

## LOW (43)
Косметика/долг: стейл-комментарии (эскалация названа TODO хотя реализована; verbalize ссылается на ElevenLabs хотя TTS=Yandex; «эскалация на Haiku» — модель забракована), дрейф именования тира `haiku`-слот, расхождения CLAUDE.md↔код (market_news не в карте), мягкий бюджет-кап эксперта, `viaShell`/`temperature`/`HashEmbeddingProvider`/`parseDeepgramMessage` неиспользуемые, и пр. Полный список — в выводе воркфлоу.

## Заметки
- Находка «distiller не передаётся в createSkillProvider» — **уже неактуальна** (срез снят до проводки `skillDistiller` в server.ts:211, сделана в этой же сессии).
- `sim.ts`/`orders.ts`/`risk.ts` «мертвы в проде» — **осознанно**: фундамент будущего исполнения / аналитика (исполнение деньгами не начато по дизайну).
