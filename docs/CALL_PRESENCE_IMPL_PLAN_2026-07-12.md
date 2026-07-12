# Инженерный план: call-слой Джарвиса (голос в звонках Discord/СберДжаз/Zoom/Meet/Teams/Telegram + ведение дейли-стендапа)

## 1. TL;DR

**Как Джарвис попадает в звонок голосом и слышит его — два независимых канала:**

- **СЛЫШИТ (inbound):** выход приложения звонка перехватывается **per-process loopback** (`ActivateAudioInterfaceAsync` с `PROCESS_LOOPBACK` по PID приложения звонка) в **C#-сайдкаре** → PCM16 → ресемпл → **второй, независимый** Deepgram-стрим (`diarize=true`) → в agent-петлю как «реплики собеседников». Ключевое: per-process INCLUDE-loopback по PID приложения звонка **по конструкции не содержит голоса самого Джарвиса** (его TTS уходит во ВХОД звонка, а не в его рендер) → проблема самотранскрипции решается архитектурно, **без акустического AEC**.
- **ГОВОРИТ (outbound):** здесь развилка — **официальный bot-API там, где он есть, виртуальный микрофон там, где его нет.**

**Ключевой архитектурный выбор (двухпутёвый):**

| Путь | Когда | Механика |
|---|---|---|
| **Официальный voice-API** | Discord (полный дуплекс, Node) | `@discordjs/voice`: PCM прямо в звонок, per-user receive — диаризация бесплатно, **0 драйверов** |
| **Virtual-mic + loopback** | СберДжаз, Google Meet, Zoom (без enablement) | TTS-PCM → `setSinkId('CABLE Input')` → приложение слышит `CABLE Output` как микрофон; собеседники через per-process loopback |

**Что требует установки/админ-прав (разовый онбординг владельцем, НЕ рантайм):**
- **VB-CABLE** (`VBCABLE_Setup_x64.exe -i -h`) — production-подписанный kernel-драйвер, **без** `testsigning`, но **системный Windows-Security-промпт «доверять издателю» неотключаем** + reboot. Создаёт пару `CABLE Input`/`CABLE Output`.
- Для Discord — регистрация бота в Developer Portal + bot-token (не userbot).
- Ручной выбор `CABLE Output` микрофоном в приложении звонка (программно чужому приложению вход не переключить чисто).

**Дефолт всего слоя: `JARVIS_CALL_MODE=0`. Автономного захода в звонок из петли НЕТ** — только явная команда владельца + confirm (см. §6).

⚠️ **Риск №1 к проверке первым:** per-process loopback требует Windows build **≥ 20348**; у владельца **19045** (22H2, но билд < 20348) → на голой 19045 Process Loopback API **может отсутствовать**. Фолбэк — system-loopback (`WasapiLoopbackCapture`) с наушниками у владельца. **Проверять живьём до любой другой работы.**

---

## 2. Матрица приложений

| Приложение | Путь (send/receive) | Авторизация | РФ-доступ | ToS-риск | Качество/латентность | Сложность |
|---|---|---|---|---|---|---|
| **Discord** | ✅ **Официальный полный дуплекс** `@discordjs/voice` (Node). Send: PCM16/48k/**stereo**/20мс кадр = 3840 байт → SDK жмёт Opus. Receive: `receiver.subscribe(userId)` — per-user Opus + события `start`/`end` → **диаризация по userId бесплатно** | Бот-token (Developer Portal, OAuth2, intent `GUILD_VOICE_STATES`). **НЕ userbot** | Троттлинг с 2024, но бот коннектится с сервера/через VPN — работает | **Низкий** для бота; self-bot = бан | Реалтайм | **Низкая** — 0 драйверов, чистый Node, ложится на сервер |
| **Zoom** | Частичный. **Send: только Meeting SDK** (C++, `IZoomSDKAudioRawDataHelper.setExternalAudioSource`, PCM16LE, гейт `onMicStartSend`). **Receive: RTMS** (Node/Python, WebSocket, per-participant) — **receive-only, говорить не умеет** | Meeting SDK app + **«special enablement» на raw-audio** (запрос в Zoom) + recording-consent баннер | Работает | Средний — боты легальны, нужна пометка записи | Реалтайм | **Высокая** — enablement-гейт + C++ обёртка |
| **Google Meet** | **Send: официального НЕТ.** Meet Media API — **consume-only** (audio/video/metadata, инъекция аудио не поддержана), + закрытый Developer Preview (все участники должны быть в программе) | OAuth + Preview-программа | Работает | Средний | Реалтайм (receive) | Send → **только virtual-mic** |
| **MS Teams** | ✅ Официальный дуплекс: Graph Communications Calling / Bot Media SDK (`Microsoft.Graph.Calls.Media`), 50 кадров/с × 20мс, SILK/G.722. **Только C#/.NET + Azure** | Azure Bot + app registration + **согласие админа тенанта** | Работает (Azure) | Средний, enterprise-гейт | Реалтайм | **Очень высокая** — но **у нас УЖЕ есть C#-сайдкар** → туда сажать. Для чужих тенантов — нереально |
| **Telegram** | Дуплекс через **userbot** (MTProto, не Bot API). Node: `tgcallsjs` + `gram-tgcalls` (поверх GramJS). Send зрелее receive | Userbot-сессия (у нас **уже есть GramJS** в `packages/userbots`) | ✅ **Без VPN** | Серая зона; Telegram терпимее к userbot, риск флудвейтов | Реалтайм, нативный WebRTC-бинарник | Средняя, но нативная зависимость |
| **СберДжаз** | ⚠️ **Официального bot/injection API НЕТ.** SaluteJazz SDK (Web/Electron) управляет своими медиапотоками. Гипотеза: встроить Web-SDK в свой Electron, подсунуть синтетический `MediaStreamTrack` (TTS) как микрофон + читать remote-потоки для STT | SDK Key → transport-token → jazz-token | ✅ **Основной РФ-таргет** | — | ? (не проверено вживую) | **Fallback: virtual-mic** (надёжнее) ИЛИ Web-SDK-embed (`confidence low` на API-хук) |

**Где официального пути НЕТ → fallback на virtual-mic + loopback:** **СберДжаз** (главный РФ-кейс для дейли), **Google Meet (send)**, **Zoom без enablement**. Именно поэтому VB-CABLE — не «одно из», а **базовая инфраструктура** для РФ-сценария.

---

## 3. Целевой аудио-поток в оба конца

### ГОВОРИТ (Джарвис → собеседники)

```
[Node-сервер]                          [Electron client]                    [Windows audio]        [приложение звонка]
yandex-tts-v3.ts                       audio.ts / PcmLivePlayer
LINEAR16 PCM16 22050  ──speak.chunk──►  ресемпл 22050→48000              ──► setSinkId              выбран микрофоном
(TtsChunk format:pcm16)   (WS)          (call mode: sink=CABLE Input)         'CABLE Input'    ────►  'CABLE Output'  ──► собеседники
                                        иначе → WebAudio (колонки)            (VB-CABLE провод)                          (Opus-кодек звонка)
```

**Discord-путь (официальный, минует CABLE):**
```
Node: yandex-tts-v3 PCM16 → ресемпл 22050→48000 STEREO → createAudioResource(StreamType.Raw) → @discordjs/voice (Opus) → голосовой канал
```

### СЛЫШИТ (собеседники → Джарвис)

```
[приложение звонка]      [C#-сайдкар: WasapiBridge.cs]                    [Node-сервер: 2-й STT-лейн]
рендерит ТОЛЬКО      ──► ActivateAudioInterfaceAsync                 ──►  Deepgram WS #2
удалённых участников     PROCESS_LOOPBACK INCLUDE PID звонка         (base64  (diarize=true, diarize_model=latest/v1,
(наш TTS в его mic,       float32/48k → downmix mono → PCM16 16к      chunk    sample_rate=48000 или 16000, linear16)
не в его выход)          (или 48к mono, экономия CPU)                 stdio)   → speaker N → agent-петля как «реплика собеседника»
```

**Discord-путь:** `receiver.subscribe(userId)` → Opus → декод `@discordjs/opus`/`prism-media` → PCM → Deepgram. **userId = имя говорящего сразу**, диаризация не нужна.

### Исключение самотранскрипции (без AEC)

1. **Структурно:** per-process INCLUDE-loopback по PID приложения звонка **не содержит** TTS Джарвиса — тот идёт во ВХОД звонка (`CABLE Output`), а приложение не рендерит свой вход обратно на выход (local monitoring выкл по умолчанию).
2. **Страховка-гейт:** не поднимать call-STT, когда pipeline в состоянии `speaking` (тот же полярный гейт, что уже работает для микрофона владельца).
3. **Опасный случай — side-tone/«слышу себя» в звонке ИЛИ владелец слушает через колонки:** тогда возможна утечка → держать owner-lane в call-режиме только на wake+стоп-слове, а не полном STT (см. §5).

**Где что живёт:** захват выхода — **C#-сайдкар** (`WasapiBridge.cs`, рядом с существующим WASAPI-детектором); вывод в CABLE — **Electron рендерер** (`setSinkId`, сайдкар не нужен); STT/TTS/оркестрация — **Node-сервер**.

---

## 4. Инкременты (по порядку рычага)

### Инкремент 0 — Живой зонд Windows-совместимости (0.5 дня, блокирующий)
- **(а)** Проверить наличие Process Loopback API на билде 19045; замерить латентность VB-CABLE после установки.
- **(д) Требует живого:** установка VB-CABLE + минимальный C#-зонд `ActivateAudioInterfaceAsync(PROCESS_LOOPBACK)` на PID Discord/браузера. При `E_NOTIMPL`/недоступности → зафиксировать фолбэк (system-loopback + наушники).
- **(е)** нет env, это ручной чек-лист.

### Инкремент 1 — **Discord CallProvider (эталон, ПЕРВЫЙ)** (3–5 дней)
- **(а) Что делает:** Джарвис заходит ботом в голосовой канал Discord, говорит (TTS) и слышит участников (per-user STT). Полный дуплекс без единого драйвера.
- **(б) Файлы/интерфейсы:**
  - Новый `apps/server/src/voice/call-bridge/index.ts` — интерфейс `CallProvider { join(target), speak(pcmStream), onParticipantAudio(cb), leave() }` (абстракция как `voice-providers.ts` для STT/TTS).
  - `apps/server/src/voice/call-bridge/discord.ts` — адаптер на `@discordjs/voice`.
  - `packages/tools/src/index.ts` — COLD-инструменты `call_start`/`call_stop` (outward, за confirm-гейтом).
  - `brain/tools/dispatch.ts` + новый `handlers/call.ts` — маршрутизация.
- **(в) Переиспользуется:** `yandex-tts-v3` PCM16-поток (ресемпл 22050→48000 stereo — **чистая функция, юнит-тест**); persistent Deepgram WS (`integrations/deepgram.ts`) — как **второй** экземпляр под receive-стрим; barge-in логика pipeline.
- **(г) Юнит-тесты:** резолв провайдера по имени приложения; ресемпл 22050→48000 stereo; кадрирование 20мс/3840 байт; маппинг userId→speaker; FSM `join/speaking/listening/leave`; гейт «говорить только когда собеседник молчит».
- **(д) Требует живого:** бот-token + тестовый Discord-сервер; сквозной звонок (собеседник слышит Джарвиса, Джарвис слышит собеседника).
- **(е)** `JARVIS_CALL_MODE=0` (деф), `DISCORD_BOT_TOKEN`, `JARVIS_CALL_PROVIDER=discord`.

### Инкремент 2 — **Virtual-mic outbound (VB-CABLE) для СберДжаз/Meet** (3–4 дня)
- **(а) Что делает:** TTS Джарвиса маршрутизируется в `CABLE Input` вместо колонок → любое приложение слышит его как микрофон. Универсальный send-путь для приложений без API.
- **(б) Файлы/интерфейсы:**
  - `apps/client/main` — новый `DeviceManager` (`navigator.mediaDevices.enumerateDevices()` → найти `CABLE Input` в `audiooutput`; `setSinkId(deviceId)` на узле `PcmLivePlayer`).
  - `apps/client/renderer/audio.ts` — `PcmLivePlayer` получает опцию `sinkId` (роутинг WebAudio-выхода).
  - Состояние `callMode` в клиенте: чанк → `WebAudio(колонки)` / `sink=CABLE` / оба.
- **(в) Переиспользуется:** `PcmLivePlayer` (уже играет сырой PCM-чанк — добавляется только выбор sink); TTS-поток сервер→клиент как есть.
- **(г) Юнит-тесты:** выбор `deviceId` по подстроке имени (фейковый список эндпоинтов → выбрался `CABLE Input`, честная ошибка если кабеля нет); роутинг-стейт-машина «куда идёт чанк»; ресемпл/downmix чистой функцией.
- **(д) Требует живого:** установка VB-CABLE (админ, Windows-Security-промпт, reboot); подтверждение что СберДжаз/Zoom **видят** `CABLE Output` микрофоном и собеседник **слышит**; замер end-to-end латентности (синтез + кабель ~14–21мс + буфер звонка).
- **(е)** `JARVIS_CALL_OUT_DEVICE="CABLE Input"` (деф, подстрока для матча).

### Инкремент 3 — **Inbound per-process loopback (C#-сайдкар)** (4–6 дней)
- **(а) Что делает:** сайдкар захватывает голоса собеседников из приложения звонка чистым потоком → второй STT-лейн. Джарвис «слышит» звонок в СберДжаз/Meet/Zoom, где нет receive-API.
- **(б) Файлы/интерфейсы:**
  - `apps/sidecar-win/WasapiBridge.cs` — `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, {ProcessLoopbackParams: TargetProcessId=<PID>, Mode=INCLUDE_TARGET_PROCESS_TREE})`; ⚠️ `GetMixFormat` в process-loopback возвращает `E_NOTIMPL` → **WAVEFORMATEX задаём вручную** (48000/16/2 или float32), downmix→mono, ресемпл→16к при необходимости.
  - `apps/sidecar-win/Ipc.cs` — новые команды `call.loopback.start{pid}`/`call.loopback.stop`, PCM base64-чанки `call_audio.chunk` (как speaker-сайдкар).
  - `apps/client/main/skill-runner/sidecar-protocol.ts` (или соответствующий) — новый тип сообщения.
  - Node: второй Deepgram-лейн получает эти чанки.
  - PID звонка резолвится через уже готовый `window_list`/сайдкар по имени процесса (Discord/Jazz/Zoom/Teams).
- **(в) Переиспользуется:** WASAPI-инфраструктура сайдкара (форматы, event-loop, MMCSS), stdio newline-JSON транспорт, `window_list` для PID.
- **(г) Юнит-тесты:** downmix stereo→mono; сборка Deepgram-URL с `diarize=true&sample_rate=48000`; парсинг speaker-меток; дедуп/эндпоинтинг реплик собеседников; гейт «не слушать своё `speaking`»; парсинг команд протокола.
- **(д) Требует живого:** сам `ActivateAudioInterfaceAsync` process-loopback (реальный звонок с рендерящимся звуком + **проверка билда 19045** из Инкремента 0); реальная латентность и качество диаризации на многоголосье.
- **(е)** `JARVIS_CALL_IN_MODE=perprocess` (фолбэк `systemloopback`).

### Инкремент 4 — **Facilitator дейли-стендапа** (5–7 дней)
- **(а) Что делает:** детерминированный FSM ведёт стендап: `OPENING → для каждого из ростера {ASK → LISTEN_UNTIL_TURN_END → COLLECT → NEXT} → SUMMARY`. Джарвис говорит только в `ASK`/`SUMMARY`.
- **(б) Файлы:** новый facilitator-модуль в `brain` как долгая §20-задача/навык «вести стендап»; конечный автомат поверх событий `{vad_speech_start/end, diarization_label, stt_final, silence_ms, wake_detected}`.
- **(в) Переиспользуется:** Deepgram endpointing/`speech_final` (`pipeline.onProviderEndpoint`) как end-of-turn; WASAPI-сайдкар как VAD floor-detector («эфир занят/свободен» + overlap→молчать); barge-in против входящего потока; опц. speaker-сайдкар sherpa-onnx для маппинга SPEAKER→имя через enrollment; UIA-сайдкар как fallback для клика mute.
- **(г) Юнит-тесты:** **весь FSM детерминирован** — синтетические последовательности событий → переходы (спросил→ждёт→следующий); floor-gating (overlap→молчит); fail-safe (неопределённость→LISTEN); сборка повестки/резюме; очередь участников; wake-фильтр на входящем `stt_final`.
- **(д) Требует живого:** точность стриминг-диаризации на реальном многоголосье/в шуме; wake-детект «Джарвис» в транскрипте звонка (ложные срабатывания); barge-in акустика.
- **(е)** `JARVIS_STANDUP_SILENCE_MS=800` (порог конца хода, диапазон 600–1000), `JARVIS_STANDUP_ROSTER` (список участников).

**Первый инкремент = Discord (§8 обоснование).**

---

## 5. «Режим звонка» в voice-pipeline

**Не новое состояние FSM, а `CallSession`-обёртка, переключающая источник/сток вокруг существующего `idle/listening/thinking/speaking`.** `pipeline.ts` кормит STT в `state==='listening'` из клиентского аудио (~строки 390–394) — call-режим оставляет тот же reducer, но:

- **Источник STT** меняется: owner-мик → per-process loopback звонка (голоса собеседников).
- **Сток TTS** меняется: колонки → `CABLE Input` (`setSinkId`) / Discord-канал.
- `thinking`/`speaking`, пофразный стрим, `speakQueued`/`PhraseSpeaker` — **как есть**.

**Dual-lane STT (критично для сосуществования и безопасности):**

| Лейн | Источник | Назначение | В call-режиме |
|---|---|---|---|
| **lane-call** | loopback звонка | понимание собеседников, diarize | полный STT |
| **lane-owner** | реальный микрофон | команды/стоп-слово владельца | **только wake + стоп-слово** (короткий грамматический фильтр, не полный STT) |

Ограничение owner-lane до wake+стоп нужно, потому что если владелец слушает собеседников **через колонки** (не наушники), их звук попадёт в owner-мик — полный STT там дал бы фантомные команды.

**Barge-in переопределяется — в ОБЕ стороны:**
- Речь **собеседника** поверх TTS Джарвиса → **отменить TTS** (уважаем floor; VAD держим активным даже во время своего плейбека, грейс ~250мс).
- Речь **владельца** через owner-lane (стоп-слово) → мгновенный mute + выход (стоп-канал).
- **НЕ** рубим TTS от собеседника как «команду» — он не владелец.

**Изоляция двух контекстов достаётся бесплатно из выбора устройств:** контекст A (десктоп: реальный мик + колонки, wake активен) и контекст B (звонок: loopback + CABLE). Эхо между ними отсутствует по конструкции (см. §3).

**Turn-taking стендапа (три уровня детекции конца хода):**
1. **VAD** (сайдкар, floor-detector) — быстрый, но рвёт на паузах.
2. **STT-endpointing** (Deepgram `endpointing=300` + `speech_final`, **уже проброшен** через `pipeline.onProviderEndpoint`) — база.
3. **Опц. семантический гейт** на partial-транскрипте — выигрыш латентности (эталон: LiveKit turn-detector на Qwen2.5-0.5B, 14 языков вкл. русский, −39% ложных перебиваний, без роста латентности; ⚠️ интеграция своей модели — отдельная работа, не в MVP).

Порог тишины **800мс** (LiveKit: «добавляет почти секунду к каждому ответу» — для стендапа терпимо, не dyadic-чат). **Fail-safe приоритетнее отзывчивости: при любой неопределённости (overlap / диаризация путается / речь не смолкла) — остаёмся в LISTEN, TTS не начинаем.** Overlap трактуем как «эфир занят», а не «кто-то договорил».

**Опрос участников:** агент сам управляет очередью («Пётр, твоя очередь») → ждёт ОДНОГО отвечающего → метку диаризации в имя резолвить не обязательно (следующий говорящий = тот, кого позвали). Реакция вне повестки — **только по явному wake-обращению** («Джарвис, …») в транскрипте звонка; семантический авто-детект «вопрос ко мне» в 4-голосье слишком ложно-срабатывает.

---

## 6. Безопасность (обязательно)

**Речь Джарвиса от лица владельца при других людях = outward-публикация класса «отправка сообщения», НЕ desktop-команда.** Строим поверх существующих send-гардов `handlers/messaging.ts` (confirm-once/cadence/идемпотентность) + durable-лог `obs/file-log`.

**Реализация поверх существующих confirm-гардов:**

1. **Гейт активации (не автономно):** call-режим **НЕ включается из петли** — только явной командой владельца («веди стендап»/«зайди в звонок») + **подтверждение вслух перед первым словом в звонок** (паттерн `requestConfirm` из `gateway/session.ts`). `JARVIS_CALL_MODE=0` по умолчанию; **запрет автоприсоединения к встречам**.

2. **Confirm на реплику (конфигурируемо):** два уровня —
   - `JARVIS_CALL_CONFIRM=session` — один confirm на вход в звонок (для доверенного стендапа своей команды);
   - `JARVIS_CALL_CONFIRM=each` — confirm перед **каждой** репликой на людях (для чувствительных звонков).

3. **Durable-лог каждой произнесённой-в-звонок фразы** в `obs/file-log` (`server-YYYY-MM-DD.log`) и `metrics.jsonl` с пометкой `outward + callSession` — трактуется как отправленное сообщение (аудируемость).

4. **Стоп-слово / kill:** owner-lane ловит стоп-слово («заткнись»/«стоп») → **мгновенный mute CABLE (прекращаем подачу сэмплов) + выход из call-режима** (переиспользовать `pipeline.stop`/cut). Mute самого Джарвиса = **feed-control** (не подаём сэмплы в `CABLE Input` — детерминированно, приложение-агностично, юнит-тестируемо), **не** UIA-клик кнопки mute (хрупко, per-app).

5. **Запрет молчаливой подмены системного микрофона связи:** переназначать дефолтное communications-устройство ОС (через недокументированный `IAudioPolicyConfig`/`PolicyConfig`) **ЗАПРЕЩЕНО** — это увело бы **весь** звук владельца в бота. Только честный онбординг «выбери CABLE Output микрофоном один раз».

6. **Этика/согласие («не выдаёт себя за живого владельца без ведома собеседников»):**
   - Опциональное **авто-представление** «на связи ассистент» при входе (по требованию/настройке).
   - Хранение транскриптов участников = **персданные (152-ФЗ** при наличии ФИО) → помечать в UI «ассистент слушает созвон», retention-политика.
   - Многие орг-политики и **дух ToS Zoom/Teams** (у них потому и нет API впрыска аудио) требуют, чтобы участники знали про ИИ.

**Мокабельно (юнит):** outward-confirm/лог/стоп-слово (как тесты messaging-гардов), полярность стоп-слова, дедуп реплик, feed-control gate.

---

## 7. Риски и обходы

| Риск | Детали | Обход |
|---|---|---|
| **Process Loopback на build 19045** | API есть с 20348; 19045 < 20348 → может отсутствовать (`confidence low`) | **Проверить первым (Инкремент 0).** Фолбэк: system-loopback `WasapiLoopbackCapture` + наушники у владельца (тогда звонок — единственный источник) ИЛИ обновление Windows |
| **Эхо/самотранскрипция** | Если у звонка side-tone/«слышу себя» ИЛИ владелец на колонках | Структурно снято per-process INCLUDE-loopback; страховка — гейт «не слушать своё speaking» + owner-lane только wake |
| **Драйвер-установка** | VB-CABLE — kernel-mode, Windows-Security-промпт **неотключаем**, нужен reboot, админ | Честный elevated-онбординг «нужны права администратора»; тихая часть `-i -h`; Chocolatey `choco install vb-cable` |
| **ToS-баны ботов** | Discord: userbot → бан (используем БОТ). Zoom/Teams: боты требуют recording-consent. Telegram: userbot — серая зона, флудвейты | Discord — только bot-token; Telegram — не агрессивить; virtual-mic формально обходит анти-SDK-бот политики, но consent всё равно нужен |
| **Латентность** | Собеседник→текст ~0.3–0.6с (Deepgram nova-3 P50 ~516мс + diarize +150–300мс). CABLE +14–21мс. TTS первый чанк ~143мс (yandex3) | Event-driven WASAPI-capture (10мс период), MMCSS-приоритет; слать 48к mono linear16 (без лишнего ресемпла); для стендапа терпимо |
| **Диаризация** | Deepgram: `diarize_model=latest/v1` (**v2 в стриме недоступен**, вернёт validation error); работает только на final; отдаёт анонимные SPEAKER_N, не имена. Overlap деградирует (phantom turns) | Для стендапа — управляемая очередь (позвал → ждёт одного); маппинг в имена — опц. через speaker-сайдкар sherpa (enrollment). Альт. AssemblyAI Universal-3 (P50 ~307мс, −91% phantom-turns) — если Deepgram не хватит |
| **РФ-доступ** | Realtime облачные API из РФ заблокированы; Discord троттлится | Discord-бот коннектится с сервера/через VPN (v2rayN уже в среде); СберДжаз/Telegram работают без VPN — **приоритет РФ-таргетов** |
| **СберДжаз API-хук** | Web-SDK-embed синтетического mic-трека — `confidence low`, API не подтверждён | Не полагаться; **дефолтный путь СберДжаз = virtual-mic** (надёжно) |
| **VB-CABLE лицензия** | Donationware; bundle требует volume-license (100 шт €3.61) или «значимого доната» $500–2000 | Для одиночного владельца — просто донат, проблем нет. Для hosted/раздачи — учесть |

---

## 8. Рекомендация: первым — **Discord CallProvider (Инкремент 1)**

**Почему (максимум реалистичность × верифицируемость):**

1. **Единственный сквозной дуплекс без внешних зависимостей:** проверяется **без драйверов, без платного enablement, без admin-consent** — в отличие от Zoom (special-enablement), Teams (Azure + тенант-админ), Meet (нет send вообще), СберДжаз (API-хук неизвестен).
2. **Идеально ложится на стек:** формат Discord = ровно наш **PCM16/48k** (нужен лишь mono→stereo ресемпл, чистая функция); receive даёт **userId = диаризация бесплатно**, минуя всю сложность стриминг-диаризации Deepgram.
3. **Обходит риск №1:** не зависит от Process Loopback API (недоступного, возможно, на 19045) — receive идёт через SDK, не через WASAPI-сайдкар. Даёт рабочий call-слой **пока** Инкремент 0 проверяет loopback-совместимость.
4. **Эталон для абстракции:** реализует `CallProvider` начисто → последующие адаптеры (Zoom/Teams/virtual-mic) наследуют интерфейс и FSM.
5. **Верифицируемость:** вся логика (ресемпл, кадрирование 20мс/3840 байт, FSM, гейт floor) — юнит-тесты; живой прогон — один бот-token + тестовый сервер (несравнимо дешевле enablement-заявок и Azure-тенанта).

**Порядок дальше:** Инкремент 0 (зонд, параллельно) → **1 (Discord)** → 2 (virtual-mic out, разблокирует СберДжаз/Meet) → 3 (loopback in, если 19045 поддерживает) → 4 (facilitator стендапа). Для главного РФ-сценария «дейли в СберДжазе» критический путь = **2 + 3 + 4** (официального API нет), но Discord даёт проверенный дуплекс и отлаженный `CallProvider`/FSM/гейты безопасности раньше и дешевле всего.

---

## Источники

- VB-CABLE: vb-audio.com/Cable/ · VBCABLE_ReferenceManual.pdf · licensing.htm · community.chocolatey.org/packages/vb-cable
- Virtual audio drivers: github.com/VirtualDrivers/Virtual-Audio-Driver · github.com/JannesP/AudioMirror
- WASAPI/loopback: learn.microsoft.com — activateaudiointerfaceasync, applicationloopbackaudio-sample, audioclient_process_loopback_params, process_loopback_mode, loopback-recording · github.com/microsoft/Windows-classic-samples/issues/275 · github.com/naudio/NAudio (WasapiOut.md, EnumerateOutputDevices.md, issues/878)
- Discord: discordjs.dev — AudioReceiveStream, VoiceReceiver · discord.com/developers/docs/topics/voice-connections · support.discord.com — Automated-User-Accounts-Self-Bots
- Zoom: developers.zoom.us/docs/rtms/ · github.com/zoom/rtms · devforum.zoom.us/t/send-raw-audio-using-windows-meeting-sdk/99486 · community.zoom.com — audio-injection-ai-bot-capabilities
- Teams: learn.microsoft.com — real-time-media-concepts, requirements-considerations-application-hosted-media-bots · microsoftgraph.github.io/microsoft-graph-comms-samples
- Google Meet: developers.google.com/workspace/meet/media-api (overview, concepts)
- Telegram: github.com/tgcallsjs/tgcalls · github.com/tgcalls/awesome-tgcalls
- СберДжаз: developers.sber.ru/portal/products/salutejazz/sdk · github.com/salute-developers/jazz-web-sdk-demo
- Deepgram/диаризация: developers.deepgram.com/docs/diarization · reference/speech-to-text/listen-streaming
- Turn-taking: livekit.com/blog — turn-detection-voice-agents, improved-end-of-turn-model · assemblyai.com/blog — streaming-speaker-diarization, turn-detection-endpointing
- Recall.ai (output-media эталон): recall.ai/blog/how-to-build-a-meeting-bot · ycombinator.com/launches/M9k-recall-ai-output-media-api
- setSinkId: developer.chrome.com/blog/audiocontext-setsinkid · media-devices
- Файлы Джарвиса: apps/client/main/actuators/system.ts (peak-метр, ~109–121), sensors-cheap.ts (case 'sound'), apps/server/src/voice/pipeline.ts (~390–394), apps/sidecar-win/Ipc.cs, apps/client/renderer/audio.ts (PcmLivePlayer), integrations/yandex-tts-v3.ts, integrations/deepgram.ts, handlers/messaging.ts

*Помечено как неуверенное:* доступность Process Loopback на build 19045 (`low`); СберДжаз Web-SDK-embed синтетического mic-трека (`low`, API-хук не подтверждён); программное переключение входа чужого приложения (`low`, чистого API нет).