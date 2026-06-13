# Jarvis — техническая спецификация (v1.2)

> v1.2 — ревизия полноты концепции: контекст экрана/дейксис (§19), модель задач и нарративность (§20), формат голосового вывода (§21), backlog (§22); UIA-паттерны вместо синтетики как основной путь действия; веб-знания server-side. v1.1 закрывала корректность (nut.js, эмбеддинги, схема, протокол, skill-runner). Полный список изменений — §23.

> Документ для реализации в Claude Code. Это **контракт и план**, а не туториал.
> Главное правило сборки: строить **вертикальными срезами** (см. §17), каждый срез — рабочий и тестируемый. Не пытаться поднять всё сразу.

---

## 0. Что это и границы

**Что это.** Персональный голосовой ассистент («Джарвис»): ambient-голос (всегда слушает по wake word), управление компьютером на Windows, переписка от лица пользователя в VK/Telegram, проактивный планировщик с умными напоминаниями, и обучение новым GUI/web-инструментам с переиспользованием выученного. Полностью облачный мозг, тонкий клиент.

**В скоупе v1.** Голосовой цикл; управление Windows (запуск приложений, мышь/клавиатура, браузер через hak-browser, исполнение кода); память (рабочая, эпизодическая, процедурная); скиллы и их ночная консолидация; проактивность и умные напоминания; переписка в VK/TG с подтверждением; заказ еды через привязанную карту с гардами; мобильный компаньон как сенсор гео + приёмник пушей; контекст экрана и дейктические запросы (§19); веб-вопросы server-side (§12); модель задач с отменой и нарративностью (§20).

**НЕ в скоупе (явно).**
- Голограммы / голографические дисплеи любого рода. Поверхность для письма — обычная камера+OCR или e-ink планшет, если вообще делается; в v1 не приоритет.
- Локальные LLM. Никаких LLM в установщике — весь интеллект через API. (Малые onnx-модели wake word/VAD — единицы МБ — в инсталлер входят, это не нарушение принципа.)
- Генеративный 3D-моделинг (3ds Max и т.п.) — способности нет ни у кого.
- Ambient-голос на iOS. iOS = пуши + гео + голос только на переднем плане. Ambient (фоновый микрофон, wake word) — **Android-first**.

**Архитектурные принципы (нарушать нельзя).**
1. **Тонкий клиент / толстый сервер.** Клиент только захватывает (аудио, экран) и исполняет (актуаторы). Вся логика, состояние и персонализация — на сервере, per-user. Клиент у всех пользователей идентичен.
2. **Грундинг по доступности, не по координатам.** Актуатор находит контролы по роли/имени в a11y-дереве (Windows UIAutomation / Chromium accessibility); пиксельные координаты и DOM-селекторы — только vision-fallback. Скилл хранит **намерение и процедуру в терминах ролей/интентов**, никогда не пиксели и не CSS-селекторы.
3. **Человеческий конверт поведения.** Все действия от лица пользователя (отправка сообщений, заказы) держатся в человеческом темпе: rate-limit, джиттер, никакого веера по многим получателям, никаких burst-серий.
4. **Подтверждение необратимого.** Отправка сообщений, заказы выше порога, любые необратимые действия требуют явного подтверждения (для рутины — выученный порог доверия).
5. **Карту не трогаем.** Агент пользуется уже привязанной картой, но **никогда сам не вводит, не хранит и не редактирует карточные/платёжные данные**. Это жёсткая красная линия без исключений.
6. **Ничего не покидает машину без активации.** Аудио стримится на сервер только после wake word или явной активации (push-to-talk/UI); активный стрим всегда индицируется (орб). Mute честный: захват остановлен, а не заглушен. Непрерывного чтения экрана нет — скриншоты и `context.read` только в рамках активной задачи или дейктического запроса (§19).

---

## 1. Архитектура (обзор)

Три потока поверх связки клиент↔сервер:
- **Голос:** микрофон → wake word (локально) → аудио-стрим на сервер → STT → brain → TTS → аудио обратно → динамик.
- **Действие:** brain решает действие → абстрактный `ActionCommand` по WS вниз → клиент исполняет своими актуаторами → `ActionResult`/скриншот наверх.
- **Проактивность:** триггер срабатывает на сервере → salience-фильтр («стоит ли сейчас») → `ProactiveNudge` на клиент → клиент произносит сам.

**Стек (явные решения, не гадать).**

| Слой | Выбор | Примечание |
|---|---|---|
| Монорепо | pnpm + TypeScript | как hak-browser |
| Клиент | Electron, electron-builder | сборка `.exe` под Windows |
| Wake word | openWakeWord (или Porcupine) | локально, ~единицы МБ; «Джарвис» по-русски требует валидации/кастомной модели — см. §18 |
| VAD | Silero VAD (onnxruntime) | локально |
| Ввод (мышь/клава) | **SendInput в win-сайдкаре** | nut.js НЕ использовать: пакеты убраны из публичного npm (платный приватный реестр), EULA запрещает редистрибуцию в составе продукта; форк протух |
| Windows a11y + ввод | **win-сайдкар на C#/.NET** (UIAutomation + SendInput) | одна нативная точка вместо двух: грундинг и клик в одном процессе, без IPC-гонок «нашёл→кликнул»; самый трудоёмкий интеграционный кусок, см. §6 |
| Браузер | puppeteer-core → **hak-browser** | для TikTok/YouTube/веба |
| Сервер | Node + Fastify | |
| Голосовой пайплайн | LiveKit Agents (Node) | WebRTC-транспорт + AEC + **штатный semantic turn detector** (мультиязычная open-weights модель, есть в Node-версии). Кастомный turn-manager НЕ писать, пока штатный не упрётся. Pipecat (Python) — fallback; чтобы swap был заменой процесса, `voice/` — отдельный процесс со стабильным контрактом (§10) |
| STT | Deepgram (streaming) | строго за интерфейсом `ISttProvider`; RU-качество — bake-off на M1 (кандидаты на замену: Gladia, Soniox, Yandex SpeechKit) |
| TTS | ElevenLabs (streaming) | |
| LLM | Anthropic SDK | тиры в §7 |
| Эмбеддинги | **OpenAI text-embedding-3-small** | у Anthropic нет embeddings API — провайдер нужен отдельный; 1536d (размерность колонки в §13 следует из этого выбора); за интерфейсом; альтернатива — self-hosted bge-m3 (1024d), см. §18 |
| Роутер | тонкий TS-слой поверх Anthropic SDK | LiteLLM-сайдкар опционально |
| БД | **PostgreSQL + pgvector** | вектора прямо в PG, без отдельного Pinecone в v1 |
| Очереди/таймеры | PG + node-cron (Redis опционально) | |
| Userbots | GramJS (Telegram), vk-io (VK) | сессия — на клиенте, см. §12 |
| ETA/маршруты | Yandex Maps / 2GIS API или self-hosted OSRM | пешком — OSRM стабилен |
| Веб-знания | Brave Search API (или self-hosted SearXNG) + readability-fetch | server-side инструменты мозга `web.search`/`web.fetch`; Q&A никогда не гоняет GUI-браузер юзера |
| Календарь | Google Calendar API / CalDAV (read-only) | за `ICalendarProvider`; вход для §9; запись — backlog §22 |

---

## 2. Репозиторий (монорепо)

```
jarvis/
├── apps/
│   ├── client/                  # Electron, Windows — единственный установщик
│   │   ├── main/
│   │   │   ├── audio/           # координация: PCM из renderer по IPC, гейтинг стрима по wake word
│   │   │   ├── wakeword/        # openWakeWord / Porcupine
│   │   │   ├── vad/             # Silero
│   │   │   ├── sensors/         # screenshot + active-window
│   │   │   ├── actuators/
│   │   │   │   ├── input.ts          # мышь/клавиатура через win-сайдкар (SendInput)
│   │   │   │   ├── apps.ts           # запуск/фокус Windows-приложений
│   │   │   │   ├── browser.ts        # драйвит hak-browser (puppeteer-core)
│   │   │   │   ├── code-runner.ts    # ограниченный раннер кода (гарантии — §6)
│   │   │   │   └── ground.ts         # запросы к win-сайдкару (UIAutomation)
│   │   │   ├── skill-runner/    # детерминированный исполнитель шагов скилла (tier-0.5), §8
│   │   │   ├── tier0/           # детерминированные команды без сети
│   │   │   └── transport/       # WebSocket/WebRTC к серверу
│   │   └── renderer/            # UI (орб/настройки/подтверждения) + ЗАХВАТ/ВОСПРОИЗВЕДЕНИЕ АУДИО (AEC — см. §3)
│   ├── sidecar-win/             # C#/.NET: UIA-грундинг + SendInput-ввод; IPC stdio/named pipe; пакуется в клиент через extraResources
│   ├── server/                  # мозг на Ubuntu
│   │   ├── gateway/             # auth, per-user сессия, WS-хаб
│   │   ├── voice/               # пайплайн: STT → диалог → TTS (LiveKit Agents)
│   │   ├── brain/
│   │   │   ├── router/          # выбор тира Haiku/Sonnet/Fable + cascade
│   │   │   ├── agent/           # цикл агента, диспетч инструментов
│   │   │   └── persona/         # сборка persona-промпта
│   │   ├── memory/
│   │   │   ├── working.ts       # кольцевой буфер сессии
│   │   │   ├── episodic.ts      # pgvector: факты/предпочтения/события
│   │   │   └── skills.ts        # CRUD SKILL.md на юзера
│   │   ├── proactive/
│   │   │   ├── triggers/        # время / контекст / внешние
│   │   │   ├── salience.ts      # Haiku: «стоит ли сейчас говорить»
│   │   │   └── scheduler.ts     # пересчёт умных напоминаний
│   │   ├── consolidation/       # ночной dreaming-крон (Haiku по логам)
│   │   ├── integrations/        # deepgram, elevenlabs, maps, geofence
│   │   └── billing/             # квоты, spend cap, kill-switch
│   └── mobile/                  # компаньон: гео-сенсор + пуши (Android-first), §12
├── packages/
│   ├── protocol/                # контракт WS клиент↔сервер (типы сообщений)
│   ├── tools/                   # схемы инструментов (общие, JSON Schema)
│   ├── userbots/                # GramJS (TG) + vk-io (VK)
│   └── shared/                  # типы, утилиты
└── infra/                       # docker-compose, миграции, деплой
```

---

## 3. Клиент (Electron, Windows)

Подсистемы клиента (где живёт — помечено):
- **audio (захват/воспроизведение — в renderer!)** — getUserMedia с `echoCancellation:true` и воспроизведение TTS через WebAudio в renderer-процессе: WebRTC AEC живёт в Chromium-пайплайне и режет только то, что играет тот же Chromium. Если захват — нативным модулем в main, а TTS — отдельным выходом, AEC не работает и barge-in слышит собственный TTS. Микрофон горячий во время TTS (full-duplex). Main получает PCM-фреймы по IPC для wake word/VAD и гейтит стрим на сервер.
- **wakeword/** — детектор фразы «Джарвис». Активирует стрим.
- **vad/** — определение начала/конца речи и факта перебивания.
- **sensors/** — скриншот, активное окно, заголовок.
- **actuators/** — исполнители `ActionCommand` (см. §6).
- **win-сайдкар** (`apps/sidecar-win`, C#/.NET) — один нативный процесс на оба нативных дела: UIAutomation-дерево + резолв «найди контрол по роли/имени» **и** синтез ввода (SendInput). IPC — stdio/named pipe. Клиент не лезет в UIA и не синтезирует ввод сам; nut.js не используется (§1).
- **tier0/** — детерминированные локальные команды (regex): «открой браузер», «выключи звук» — без сети, стоимость $0.
- **skill-runner/** — детерминированный интерпретатор шагов скилла: ground/click/type локально, без LLM в цикле; на сервер ходит только при fail шага или needsLlm-шаге (§8).
- **transport/** — постоянный WebSocket к серверу (control plane); аудио — WebRTC (LiveKit). Бинарные WS-фреймы аудио — только dev-заглушка до подъёма LiveKit, в проде не используются.
- **renderer/** — минимальный UI: индикатор состояния (idle/listening/thinking/speaking), окно настроек, **модалка подтверждения** для send/order, карточки `ui.display` (§21). Плюс весь аудио-захват/воспроизведение (см. выше).

Установщик: electron-builder → `.exe` (+ `sidecar-win.exe` через extraResources). Никаких LLM внутри; onnx-модели wake word/VAD — внутри. При первом запуске — логин (получает user-токен), привязка интеграций.

---

## 4. Сервер (Ubuntu)

- **gateway/** — аутентификация, per-user сессия. При коннекте клиента по токену загружает персону, скиллы, память и креды этого юзера. WS-хаб.
- **voice/** — оркестрация: приём аудио-стрима → streaming STT → turn-manager (когда фраза закончена / перебивание) → brain → streaming TTS → аудио клиенту.
- **brain/router/** — классифицирует запрос и выбирает тир (§7); каскад на эскалацию.
- **brain/agent/** — цикл агента: план → tool calls (эмитит `ActionCommand`) → обработка `ActionResult` → ответ. Здесь же запись/чтение скиллов.
- **brain/persona/** — сборка системного промпта: статичный префикс (кешируемый, общий для всех) + динамика юзера (персона, стиль, релевантная память) в первом сообщении.
- **memory/** — три хранилища (§8).
- **proactive/** — триггеры, salience, планировщик умных напоминаний (§9).
- **consolidation/** — ночной крон (§8).
- **integrations/** — клиенты внешних API.
- **billing/** — учёт токенов, spend cap, kill-switch per-user.

---

## 5. Протокол клиент↔сервер (`packages/protocol`)

Это центральный шов. Brain не знает про nut.js/puppeteer — он эмитит абстрактные команды, клиент мапит на актуаторы.

```ts
// Общий конверт
interface Envelope<T = unknown> {
  id: string;            // uuid сообщения
  ts: number;            // unix ms
  type: MessageType;
  payload: T;
}

type MessageType =
  // client -> server
  | "client.hello"       // Hello — первый кадр после коннекта/реконнекта
  | "audio.frame"        // только dev-заглушка до LiveKit; в проде аудио — ТОЛЬКО WebRTC, WS = control plane
  | "audio.vad"          // {state: "speech_start" | "speech_end" | "barge_in"}
  | "screen.capture.result"
  | "action.result"      // ActionResult — обязателен на КАЖДЫЙ ActionCommand, корреляция по commandId
  | "client.state"       // {state: "idle"|"listening"|"thinking"|"speaking"}
  | "user.confirm.result"// ConfirmResult
  | "client.context"     // ClientContext — занятость юзера/активное окно, вход salience (§9)
  | "demo.event"         // поток UIA-событий при записи демонстрации (§8)
  | "pong"
  // server -> client
  | "server.hello"       // {sessionId, protocolVersion, resumed: boolean}
  | "speak.chunk"        // {audio: bytes} | стрим TTS
  | "transcript"         // {text, final: boolean} | для UI/логов
  | "action.command"     // ActionCommand (см. §6); envelope.id = commandId; payload.timeoutMs обязателен
  | "screen.capture.request"
  | "user.confirm.request" // ConfirmRequest
  | "proactive.nudge"    // ProactiveNudge — клиент проговаривает сам, ЕСЛИ не истёк
  | "task.status"        // TaskStatus — прогресс/смена статуса задачи (§20)
  | "ui.display"         // DisplayCard — карточка с подробностями в renderer (§21)
  | "ping";

interface Hello { token: string; clientVersion: string; protocolVersion: number; resumeSessionId?: string; }

interface ActionResult {
  commandId: string;     // = envelope.id команды
  ok: boolean;
  error?: { code: "timeout" | "not_found" | "denied" | "disconnected" | "runtime"; message: string };
  data?: unknown;        // напр. {handle, bbox} от ui.ground, stdout от code.run
  stepIndex?: number;    // при skill.execute — номер шага
  durationMs: number;
}

interface Transcript { text: string; final: boolean; }
interface SpeakChunk { audio: ArrayBuffer; seq: number; last: boolean; }
interface ProactiveNudge { text: string; reason: string; expiresAt: number; } // просрочен → клиент НЕ произносит (§9)
interface ConfirmRequest { requestId: string; summary: string; kind: "send"|"order"|"irreversible"; expiresAt: number; } // истёк → auto-deny
interface ConfirmResult { requestId: string; approved: boolean; revision?: string; } // revision: «перепиши короче» → перегенерация → новый confirm (§14)

interface ClientContext { activeApp: string; fullscreen: boolean; micBusyByOtherApp: boolean; locked: boolean; }
interface TaskStatus { taskId: string; state: "queued"|"running"|"paused"|"waiting_confirm"|"done"|"failed"|"cancelled"; summary?: string; stepsDone?: number; stepsTotal?: number; }
interface DisplayCard { title?: string; markdown: string; }
```

**Семантика соединения (обязательная часть контракта).**
- **Версионирование:** несовпадение мажора `protocolVersion` → сервер отвечает ошибкой, клиент показывает «требуется обновление». Клиент автообновляется — рассинхрон неизбежен; он должен быть громким, не тихим.
- **Heartbeat:** ping/pong каждые 15 с; два пропуска подряд → реконнект.
- **Реконнект:** `client.hello` с `resumeSessionId`. Команды, бывшие in-flight в момент разрыва, клиент **доисполняет** и буферизует `action.result` по commandId до восстановления связи; сервер идемпотентен к повторной доставке result.
- **Таймауты:** каждый `ActionCommand` несёт `timeoutMs`; нет result дольше — сервер фиксирует `{ok:false, error.code:"timeout"}` и решает сам (retry / эскалация / отмена).

---

## 6. Актуаторы и грундинг (`apps/client/main/actuators`, `packages/tools`)

**Принцип (повторяю, потому что это замковый камень):** найти контрол по роли/имени в a11y-дереве; пиксели/DOM — только когда a11y пуст (видео-канвас TikTok/YouTube). Скилл хранит **шаги в терминах интентов и ролей**, не координаты.

Порядок резолва цели действия:
1. `ground` через UIA-сайдкар (нативные и Electron/Chromium-приложения — VK Messenger это Chromium, у него богатая a11y).
2. Для веба внутри hak-browser — accessibility-дерево puppeteer / роли ARIA.
3. **Vision-fallback:** скриншот → LLM с vision → координаты. Дорого, только если 1–2 не дали контрол. Координаты vision — в пикселях скриншота: маппинг в SendInput строго через Per-Monitor DPI Awareness V2 и виртуальные экранные координаты — мультимонитор и скейлинг 125/150% — классическое место «кликнул не туда».

**Действие после грундинга — паттерны прежде синтетики.** Найденный контрол сначала дёргается UIA-паттерном (`ui.invoke`: InvokePattern, ValuePattern.SetValue, SelectionItemPattern, TogglePattern, ScrollPattern) — это работает по handle, **без фокуса и без захвата курсора**: юзер продолжает пользоваться машиной, пока Джарвис действует в фоновом окне. Синтетический ввод (`input.click`/`input.type` через SendInput) — fallback, когда паттерн не поддержан, и единственный путь для vision-координат. Скилл способ не фиксирует — runner выбирает по доступности паттерна на месте.

**Арбитраж ввода (user takeover).** Сайдкар во время активной задачи слушает физический ввод (raw input); синтетика маркируется (extra-info у SendInput) и отличима. Физическая активность мыши/клавиатуры во время задачи, идущей через синтетику или требующей фокуса, → задача немедленно `paused` (§20), голосом: «вижу, ты за компьютером — продолжить или отложить?». Задачи целиком на UIA-паттернах в фоновом окне не паузятся — конфликта за курсор нет.

Типы команд:

```ts
type ActionCommand =
  | { kind: "input.type"; text: string }
  | { kind: "input.key"; combo: string }                  // "Ctrl+S", "ArrowRight", "Space"
  | { kind: "input.click"; target: Target }                       // синтетический ввод — FALLBACK (см. выше)
  | { kind: "ui.invoke"; target: Target; pattern: "invoke"|"setValue"|"select"|"toggle"|"expand"|"scroll"; value?: string } // UIA-паттерны — ОСНОВНОЙ путь действия
  | { kind: "ui.ground"; query: { role: string; name?: string } } // -> возвращает handle/bbox
  | { kind: "app.launch"; app: string }
  | { kind: "app.focus"; app: string }
  | { kind: "browser.open"; url: string }
  | { kind: "browser.act"; intent: "play"|"next"|"scroll"|"pause"; params?: object } // hak-browser
  | { kind: "browser.read"; selectorIntent: string }       // извлечь контент
  | { kind: "code.run"; lang: "python"|"node"|"powershell"; code: string }    // ограничения ниже — обязательны
  | { kind: "skill.execute"; skillId: string; version: number; steps: SkillStep[]; params?: object } // skill-runner, §8
  | { kind: "screen.capture" }
  | { kind: "context.read"; scope: "selection"|"active_window"|"screen" }       // дейксис, §19
  | { kind: "demo.record"; op: "start"|"stop" }                                 // обучение демонстрацией, §8
  | { kind: "message.send"; channel: "vk"|"telegram"; to: string; body: string } // ТРЕБУЕТ confirm + cadence guard
  | { kind: "order.place"; vendor: string; items: object[]; total: number };      // ТРЕБУЕТ confirm + spend cap + idempotency

// Target грундится по роли/имени; coords — крайний fallback
type Target =
  | { by: "role"; role: string; name?: string }
  | { by: "handle"; handle: string }       // из предыдущего ui.ground
  | { by: "coords"; x: number; y: number }; // fallback only

// SkillStep — распарсенный шаг SKILL.md:
// { action; target?; params?; needsLlm?: boolean;
//   expect?: { role: string; name?: string; state?: string };  // постусловие шага
//   timeoutMs?: number; retries?: number }
// needsLlm=true (сочинить текст по месту) — единственный случай, когда runner зовёт сервер не по ошибке.
// expect — runner поллит a11y до наступления (auto-wait); по таймауту — re-ground + retry; исчерпал retries — эскалация.
// Шаг без expect — слепой клик; допускается только там, где постусловие невыразимо (видео-канвас).
```

**code.run — ограничения (без них §14 декоративен: powershell на хосте обходит app allowlist целиком).**
- Жёсткие гарантии раннера: Job Object (лимит CPU/RAM/wall-clock), сетевой доступ запрещён per-process (firewall-правило на exe раннера; allowlist доменов выдаётся на задачу), CWD = выделенный temp-каталог, лимит размера stdout.
- python/node — изолированный venv / локальный node_modules с whitelist-пакетами (openpyxl и т.п.).
- Честная оговорка: полную изоляцию ФС на хосте без контейнера не сделать — поэтому сгенерированный код проходит lint-гард **на сервере до отправки** (запрещённые API: реестр, службы, абсолютные пути вне CWD, сеть).
- powershell — ВСЕГДА `user.confirm.request` (kind:"irreversible") + Constrained Language Mode. Без исключений.

**Спец-кейсы видео-фида (TikTok/YouTube shorts).** a11y тощая → опираемся на стабильные клавиатурные аффордансы (`Space`, стрелки) и состояние плеера. «Видео кончилось» — нет чистого события по роли: ловим `<video>` `ended` (YouTube) либо состояние плеера/время/появление следующей карточки (shorts). Это самая хрупкая часть, закладывать периодический ремонт парсера. Fingerprint hak-browser снижает риск детекта, но не отменяет хрупкость.

---

## 7. Маршрутизация моделей (`brain/router`)

| Тир | Модель | model id | Когда |
|---|---|---|---|
| 0 | — (локально) | — | детерминированные команды, $0 |
| 1 | Haiku | `claude-haiku-4-5` | распознавание намерений, классификация, простые ответы, salience-проверки, напоминания, быстрые веб-лукапы |
| 2 | Sonnet | `claude-sonnet-4-6` | сочинение текста, работа с инструментами по уже известному скиллу, анализ, синтез веб-результатов |
| 3 | Fable | `claude-fable-5` | **разовое** освоение нового GUI-инструмента, сложный многошаговый агентский разбор, vision-планирование |

Каскад: пытаться снизу вверх; эскалация при низкой уверенности/неудаче. Дорогое — это *выяснить процедуру* (разовая Fable-сессия), не *исполнить* (переисполнение известного скилла идёт через клиентский skill-runner вообще без LLM; Sonnet «по скиллу» — только для шагов с генерацией контента, см. §8).

Для голоса каскад ≠ «попробовал-упал-повторил» (это двойная латентность): тир выбирается Haiku-классификатором **до** генерации; если эскалация всплыла уже в ответе — стримить короткий филлер («секунду») и продолжать на старшем тире. Недоступность Anthropic (529/таймаут): retry с backoff, после N неудач — голосом «мозг недоступен», tier-0 и skill-runner продолжают работать.

---

## 8. Память (`memory/`)

Три хранилища:
- **Рабочая** (`working.ts`) — кольцевой буфер текущей сессии, живёт в окне модели; персистится в `messages`.
- **Эпизодическая** (`episodic.ts`) — факты, предпочтения, события пользователя; pgvector, семантический поиск, поле `salience` и `stale`. Эмбеддинги — text-embedding-3-small за интерфейсом (§1).
- **Процедурная** (`skills.ts`) — выученные процедуры как `SKILL.md` + манифест; версионируется (хранить и в БД, и опционально в git). **Канонический источник — `content_md`**; `steps` в БД — derived-парс при сохранении (питает skill-runner) и напрямую не редактируется: два рукописных источника правды гарантированно разъезжаются.

**Формат SKILL.md** (одна запись = одна процедура):

```markdown
---
name: send_vk_message
description: Отправить сообщение в VK Messenger конкретному контакту
triggers: ["напиши в вк", "ответь в вк", "vk сообщение"]
tools: ["app.focus", "ui.ground", "input.type", "input.key", "message.send"]
version: 3
surface: vk-desktop            # где применимо
grounding: a11y                # a11y | vision | hybrid
---

## Шаги (в терминах ролей/интентов, НЕ координат)
1. app.focus → "VK Messenger"
2. ui.ground → role="list", name~="Чаты"; найти контакт по имени
3. input.click → найденный контакт (by handle)
4. ui.ground → role="textbox", name~="Напишите сообщение"
5. input.type → текст                            # expect: textbox содержит текст
6. message.send (через confirm + cadence guard)  # НЕ Enter напрямую в обход гарда
7. verify → последнее сообщение в чате == отправленный текст

## Грабли
- Поле ввода иногда теряет фокус после переключения чата — перегрундить перед вводом.
```

**Цикл обучения.**
1. Новая задача без скилла → Fable-сессия: исследует UI (предпочитает code/API, напр. openpyxl для Excel), грундит по ролям, на успехе **пишет SKILL.md**.
2. Следующий раз → сервер шлёт `skill.execute`, и **детерминированный skill-runner на клиенте** исполняет шаги, перегрундивая каждый заново (устойчиво к редизайну). LLM вне цикла. Эскалация на Sonnet — только при fail шага или на needsLlm-шаге (сочинить текст по месту). Именно этот слой делает переисполнение ~$0 (§15); без него каждый «дальше» в TikTok — Sonnet-вызов плюс WAN round-trip. Каждый шаг верифицируется постусловием `expect` (auto-wait + retry, §6); скилл завершается **verify-шагом** — проверкой результата всей задачи (файл существует, сообщение в «Отправленных»). Без verify «успех» скилла — самообман: кликнул и поверил.
3. **Ночная консолидация** (`consolidation/`, крон): Haiku прогоняет логи сессий за день per-user → дедуп скиллов, чинит повторяющиеся ошибки (инкремент `fail_count` → правка шагов), чистит `stale` память, промоутит паттерны (напр. время сборов). Это локальный аналог managed-фичи dreaming. **Границы автоправки:** guard-шаги (`message.send`, confirm, `code.run`/powershell) консолидация трогать не может; правка = новая версия, активируется только после первого успешного прогона; всплеск `fail_count` на новой версии → авто-rollback на предыдущую. Источник логов — `action_log` (§13), а не только `messages`: диалог не содержит механику кликов.

**Обучение демонстрацией («смотри, покажу»).** Альтернатива автономному Fable-исследованию — дешевле, быстрее и безопаснее: по команде клиент включает запись (`demo.record start`, индицируется орбом), сайдкар стримит UIA-события (`demo.event`: роль/имя элемента + действие — НЕ координаты), параллельно пишется голосовой комментарий юзера; `stop` → Fable конвертирует запись + комментарий в черновик SKILL.md → юзер подтверждает. Скилл с guard-шагами из демонстрации — обязательное ревью перед первым применением (§14). Запись только по явной команде.

---

## 9. Проактивность (`proactive/`)

**Триггеры (три класса):**
- **Время** — напоминания, расписания.
- **Контекст** — событие на клиенте (открыл приложение X) → опционально предложить помощь.
- **Внешние** — событие календаря, пришло письмо, завершился процесс.

**Salience-фильтр** (`salience.ts`): перед любым `ProactiveNudge` — дешёвая Haiku-проверка «стоит ли сейчас вмешиваться» + пользовательский do-not-disturb. Без него ассистент превращается в назойливый будильник. Входы фильтра — не только текст триггера: `client.context` (§5) даёт занятость — активный созвон (микрофон занят communications-приложением: Zoom/Discord/телефония), fullscreen-игра или презентация, залоченный экран. Занят → копить и доставить при освобождении; жёсткие дедлайны (умные напоминания) — мобильным пушем.

**Умное напоминание — это не таймстамп, а пересчитываемая функция.** Хранится **интент с дедлайном и местом**, триггер вычисляется динамически:

```
trigger_ts = deadline_ts − ETA(current_location → place, travel_mode) − prep_minutes − buffer
```

- Пересчёт по кадэнсу к приближению дедлайна и **на каждое гео-событие** (смена локации).
- `prep_minutes` — **выученное** (сколько юзер обычно собирается), не захардкоженное; уточняется консолидацией.
- ETA — из maps-API (авто/транспорт — live-пробки) или OSRM (пешком).
- Гео — **геофенсинг** (фенсы вокруг дом/зал/работа), не поллинг GPS: пересёк границу → событие. Дёшево по батарее.
- Уведомление летит на устройство, где юзер сейчас активен (presence — `last_seen_at` в `devices`, §13).
- **Просроченное не доставляется:** у nudge есть `expiresAt` (§5) — «выходи в 8:20», произнесённое в 11:00 после оффлайна, хуже молчания. Клиент оффлайн → сразу мобильный пуш; истёк — молча в лог.

Пример: «в 9 должен быть в зале», пешком 30 мин + 10 мин сборы → напоминание в 8:20; если юзер уже рядом с залом — напоминания нет; если дальше обычного — съезжает раньше само.

---

## 10. Голосовой пайплайн (`voice/`)

«Ощущение живого» = латентность + перебивание + персона + память. Это инженерия пайплайна, не фича.

- **Латентность до первого звука:** цель <800 мс от конца фразы до первого произнесённого слова. Wake word локально (мгновенно) → streaming STT с промежуточными результатами (не ждать финала) → старт LLM по уверенному транскрипту → стримить токены в streaming TTS, отдающий первый чанк после первого предложения. **Никогда не ждать полный ответ модели перед речью.** Ранний старт по interim-транскрипту — только с отменой: юзер продолжил говорить → сгенерированное выбрасывается, перезапуск по финальному транскрипту.
- **Barge-in:** full-duplex, микрофон горячий во время TTS, VAD на входе; заговорил → TTS рубится, начинается слушание. Требует AEC (WebRTC AEC даёт LiveKit).
- **Follow-up окно:** после конца TTS микрофон остаётся горячим ~6 с (конфиг) — продолжение без повторного wake word: «который час» → ответ → «а погода?». Индикация орбом; молчание → idle. Без этого каждая фраза — холодный старт, и ощущение собеседника рассыпается.
- **Анафора между репликами и задачами:** рабочая память держит стек последних сущностей (файл, контакт, URL, результат задачи); «а её отправь Маше» резолвится Haiku по этому стеку, не переспрашивая очевидное.
- **Turn detection:** штатный semantic turn detector LiveKit (мультиязычная open-weights модель, доступна в Node) поверх Silero VAD; качество на русском проверить в M1. Кастомный turn-manager — только если штатный не вытянет. Dynamic endpointing есть только в Python-версии — ещё одна причина оформить `voice/` отдельным процессом со стабильным контрактом (аудио внутрь / события наружу): swap на Pipecat тогда — замена процесса, а не переписывание мозга.
- **Персона:** фиксированный persona-промпт + один голос ElevenLabs + память (не переспрашивать известное).
- **Формат произносимого** — §21: голос и экран — разные каналы с разными правилами.

---

## 11. Профиль и стиль (`brain/persona`)

- **Зеркалирование стиля:** извлекать наблюдаемые признаки (длина, формальность, мат, прямота, регистр) → в persona-промпт. Это часть работы памяти.
- **Редактируемый док «о пользователе»:** LLM периодически сводит наблюдения (тон, что раздражает, как обращаться) в короткий документ — как **рабочую гипотезу, которую юзер правит**, не диагноз.
- **Без психометрии.** Не моделировать психику ради «давить на кнопки»: ненадёжно и превращает ассистента в движок вовлечённости вместо движка интересов пользователя. Зеркаль стиль и помни предпочтения — и только.

**Персона самого Джарвиса — артефакт, не дефолт.** `persona.md` в репо, версионируется: лаконичность (ответ — суть, без преамбул и «отличный вопрос»); сухой юмор дозированно и никогда — в ошибках, деньгах и подтверждениях необратимого; неуверенность прямым текстом («не уверен — проверить?»); без подхалимства. Форма обращения (имя / «сэр» / без) — поле `persona_config`. Зеркалирование стиля юзера накладывается ПОВЕРХ этой базы, не вместо неё: характер продукта стабилен, гибок только регистр.

---

## 12. Внешние интеграции (`integrations/`, `packages/userbots`)

- **STT:** Deepgram streaming.
- **TTS:** ElevenLabs streaming (выразительный голос).
- **LLM:** Anthropic SDK (тиры §7).
- **Maps/ETA:** Yandex/2GIS или OSRM.
- **Web/знания (server-side):** `web.search` (Brave Search API или self-hosted SearXNG) + `web.fetch` (readability-экстракция) — инструменты мозга. Вопросы знаний никогда не гоняют GUI-браузер юзера: «что нового у X» — поиск на сервере, а не открытие вкладки на десктопе.
- **Календарь (read-only, за `ICalendarProvider`):** Google Calendar API / CalDAV. События — триггеры §9 и вход умных напоминаний; запись в календарь — backlog (§22).
- **Geofence:** на мобильном компаньоне (Android-first).
- **Userbots:** GramJS (Telegram), vk-io (VK) — действуют **от аккаунта пользователя**.
  - **Где живёт сессия:** на **клиенте** — ключи/StringSession не покидают машину; хранение через Electron safeStorage (DPAPI на Windows). Честная оговорка: контент переписки, который мозг читает, всё равно идёт на сервер и в LLM API — приватность сессии ≠ приватность контента. Поэтому контракт данных явный: по умолчанию на сервер уходят только **метаданные** входящих (чат, отправитель, unread); полный тред — **по требованию** (юзер просит ответить / явно включил проактивные ответы для конкретного чата). Контент переписки на сервере не персистится дольше рабочей памяти сессии; в episodic — только выжимки-факты. Сам `send` идёт через клиентский userbot после подтверждения.
  - **Риск — поведенческий, не «автоматизация как класс».** Telegram терпим к API/сторонним клиентам — userbot на разговорном объёме низкорисковый. VK злее на автоматизацию — там предпочтительнее UI-автоматизация официального десктоп-клиента (через грундинг §6) либо официальный API с user-токеном. Антиабуз ловит спам-сигнатуру (объём, веер, одинаковый текст, burst, «новый аккаунт→рассылка») — её гасят гарды §14, а не отказ от автоматизации.
- **Mobile-компаньон (Android-first):** геофенсы — Geofencing API (Google Play Services), гео-события на сервер по HTTPS; пуши — FCM data-сообщения (nudge с `expiresAt` валидируется на устройстве). Фоновая геолокация = `ACCESS_BACKGROUND_LOCATION`: для личной сборки/sideload — ок, публикация в Play потребует обоснования по политике. iOS — рамки из §0.

---

## 13. Данные — PostgreSQL + pgvector (`infra/migrations`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text,
  locale        text DEFAULT 'ru',
  timezone      text DEFAULT 'Europe/Amsterdam',
  persona_config jsonb DEFAULT '{}',     -- стиль, голос, do-not-disturb, пороги доверия
  created_at    timestamptz DEFAULT now()
);

-- Креды интеграций. Для userbot-сессий VK/TG — храним на клиенте; сюда только серверные (maps и т.п.), зашифрованными.
-- Мастер-ключ шифрования — из env/secret-менеджера сервера, не в БД.
CREATE TABLE user_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  service       text NOT NULL,            -- 'maps' | 'deepgram' | ...
  kind          text NOT NULL,            -- 'oauth' | 'token'
  encrypted_blob bytea NOT NULL,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  started_at    timestamptz DEFAULT now(),
  ended_at      timestamptz,
  summary       text,                     -- сжатая сводка (compaction)
  tokens_in     bigint DEFAULT 0,
  tokens_out    bigint DEFAULT 0
);

CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid REFERENCES sessions(id) ON DELETE CASCADE,
  role          text NOT NULL,            -- 'user' | 'assistant' | 'tool'
  content       jsonb NOT NULL,
  tier_used     text,                     -- 'tier0'|'haiku'|'sonnet'|'fable'
  tokens_in     int DEFAULT 0,
  tokens_out    int DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE episodic_memory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,            -- 'preference' | 'fact' | 'event'
  text          text NOT NULL,
  embedding     vector(1536),
  salience      real DEFAULT 0.5,
  source_session uuid REFERENCES sessions(id) ON DELETE SET NULL,
  stale         boolean DEFAULT false,
  created_at    timestamptz DEFAULT now(),
  last_used_at  timestamptz
);
-- HNSW, не ivfflat: ivfflat обучается на данных и на пустой таблице бессмыслен; HNSW строится инкрементально.
-- На per-user объёмах (тысячи строк) индекс вообще опционален — точный скан укладывается.
CREATE INDEX ON episodic_memory USING hnsw (embedding vector_cosine_ops);

CREATE TABLE skills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  triggers      jsonb DEFAULT '[]',
  tools         jsonb DEFAULT '[]',
  steps         jsonb NOT NULL,           -- derived-парс из content_md (для skill-runner); НЕ канонический
  content_md    text NOT NULL,            -- полный SKILL.md — КАНОНИЧЕСКИЙ источник (§8)
  surface       text,                     -- 'vk-desktop' | 'youtube-web' | ...
  grounding     text DEFAULT 'a11y',      -- 'a11y'|'vision'|'hybrid'
  version       int DEFAULT 1,
  success_count int DEFAULT 0,
  fail_count    int DEFAULT 0,
  last_used_at  timestamptz,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE places (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL,            -- 'home' | 'gym' | 'work'
  lat           double precision NOT NULL,
  lng           double precision NOT NULL,
  address       text,
  geofence_radius_m int DEFAULT 150,
  UNIQUE (user_id, label)
);

CREATE TABLE habits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  pattern_type  text NOT NULL,            -- 'prep_time' | 'recurring_event' | 'order'
  description   text,
  data          jsonb DEFAULT '{}',       -- напр. {minutes: 10} для сборов
  confidence    real DEFAULT 0.5,
  updated_at    timestamptz DEFAULT now()
);

-- Умные напоминания (интент с дедлайном/местом; trigger пересчитывается)
CREATE TABLE intents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  goal_text     text NOT NULL,            -- 'быть в зале'
  place_id      uuid REFERENCES places(id) ON DELETE SET NULL,
  deadline_ts   timestamptz NOT NULL,
  prep_minutes  int DEFAULT 0,            -- из habits, выученное
  travel_mode   text DEFAULT 'walking',   -- 'walking'|'driving'|'transit'
  buffer_min    int DEFAULT 5,
  computed_trigger_ts timestamptz,        -- результат пересчёта
  status        text DEFAULT 'pending',   -- 'pending'|'notified'|'done'|'cancelled'
  last_recomputed_at timestamptz,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE proactive_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  trigger_type  text NOT NULL,            -- 'time'|'context'|'external'
  payload       jsonb DEFAULT '{}',
  salience_score real,
  suppressed    boolean DEFAULT false,    -- зарубил salience/DND
  fired_at      timestamptz
);

-- Контакты: «ответь Маше» резолвится здесь; aliases пополняет консолидация из наблюдаемой переписки.
-- Несколько совпадений по алиасу → голосовая дизамбигуация («какой Маше — Ивановой или из зала?»), не угадывание.
CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  display_name  text NOT NULL,
  aliases       jsonb DEFAULT '[]',       -- ["Маша", "Мария Иванова", "маша из зала"]
  channels      jsonb DEFAULT '{}',       -- {"telegram": "...", "vk": "..."} — id/username per-канал
  last_interaction_at timestamptz,
  source        text DEFAULT 'observed',  -- 'observed'|'imported'|'manual'
  created_at    timestamptz DEFAULT now(),
  UNIQUE (user_id, display_name)
);

-- Устройства: presence-роутинг уведомлений (§9) и пуш-токены
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,            -- 'desktop'|'mobile'
  push_token    text,
  app_version   text,
  last_seen_at  timestamptz,
  created_at    timestamptz DEFAULT now()
);

-- Задачи: статус/прогресс/отмена/наррация (§20)
CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  goal_text     text NOT NULL,
  status        text DEFAULT 'queued',    -- 'queued'|'running'|'paused'|'waiting_confirm'|'done'|'failed'|'cancelled'
  skill_id      uuid REFERENCES skills(id) ON DELETE SET NULL,
  steps_total   int,
  steps_done    int DEFAULT 0,
  result_summary text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- Исходящие сообщения от лица юзера — с гардами
CREATE TABLE outbound_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  channel       text NOT NULL,            -- 'vk'|'telegram'
  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  recipient     text NOT NULL,            -- резолвнутый адрес в канале (id/username)
  body          text NOT NULL,
  status        text DEFAULT 'pending',   -- 'pending'|'confirmed'|'sent'|'blocked' (confirmed-bool убран: два источника правды)
  cadence_ok    boolean DEFAULT false,    -- прошёл гард кадэнса/аномалии
  idempotency_key text UNIQUE,
  created_at    timestamptz DEFAULT now()
);

-- Заказы (еда и т.п.) — с гардами; карточные данные НЕ хранятся
CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  vendor        text NOT NULL,
  items         jsonb NOT NULL,
  total         numeric(10,2) NOT NULL,
  status        text DEFAULT 'pending',   -- 'pending'|'confirmed'|'placed'|'blocked' (confirmed-bool убран)
  idempotency_key text UNIQUE,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE usage_quota (
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  period        text NOT NULL,            -- 'YYYY-MM'
  tokens_used   bigint DEFAULT 0,
  cost_estimate numeric(10,2) DEFAULT 0,
  spend_cap     numeric(10,2),
  kill_switch   boolean DEFAULT false,
  PRIMARY KEY (user_id, period)           -- НЕ только user_id: иначе одна строка на юзера и помесячный учёт невозможен
);

-- Аудит всех ActionCommand/Result: источник для ночной консолидации (§8) и дебага «почему кликнул не туда».
-- messages хранит только диалог — механика действий без этой таблицы не логируется нигде.
CREATE TABLE action_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  command_id    uuid NOT NULL,
  kind          text NOT NULL,            -- 'input.click' | 'skill.execute' | ...
  payload       jsonb,
  ok            boolean,
  error_code    text,
  duration_ms   int,
  skill_id      uuid REFERENCES skills(id) ON DELETE SET NULL,
  step_index    int,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX ON action_log (user_id, created_at);
```

---

## 14. Безопасность и гарды (`billing/`, agent loop)

- **Подтверждение отправки** (`message.send`): для нетривиальных — модалка/голос «отправляю X, ок?»; для рутины — выученный порог (напр. «короткие ответы в текущих чатах — молча»). В первую очередь это страховка от «не тот текст». Confirm — не бинарный: `revision` в ответе («перепиши короче, без смайлов») → перегенерация → новый confirm; цикл правок дешевле и человечнее, чем deny и сначала.
- **Гард кадэнса/аномалии** (защита от банов): rate-limit per-channel, человеческий джиттер, **запрет веера** (нельзя писать N получателям пачкой), запрет burst-серий, запрет писать контакту, которому юзер никогда не писал, без явного подтверждения. Проактивный движок не должен в 3 ночи разослать пачку ответов на непрочитанное.
- **Spend cap + kill-switch** (`usage_quota`): лимит трат per-user; при превышении — стоп. Агент в цикле жжёт деньги быстро — нужен бесконечно-петлевой предохранитель (max шагов/токенов на задачу).
- **Идемпотентность** (`orders`/`outbound_messages` через `idempotency_key`): retry-цикл не должен оформить три заказа / отправить три сообщения подряд.
- **Заказы:** spend cap + allowlist заведений/блюд + подтверждение выше порога (настраивается: «до 1500₽ из трёх обычных мест молча, иначе спроси»).
- **Карта:** агент пользуется привязанной картой, **никогда не вводит/не хранит/не редактирует карточные данные**. Чекаут с 3DS/SCA — подтверждает пользователь сам.
- **App allowlist:** актуаторы работают только с разрешёнными приложениями.
- **Prompt-injection с экрана:** всё на скриншоте — данные, не команды. Содержимое открытых страниц не исполняется как инструкции; необратимые действия — только через гарды выше. Особый случай — Fable-сессия обучения: текст со страницы может «подсказать» вредный шаг в SKILL.md, поэтому свежевыученный скилл, содержащий guard-шаги, до первого применения показывается юзеру.
- **code.run:** ограничения из §6 обязательны (Job Object, сетевой запрет, CWD=temp, серверный lint-гард; powershell — всегда confirm).
- **Самомодификация скиллов:** границы автоправки — §8 (guard-шаги protected; новая версия активируется после успешного прогона; авто-rollback по fail_count).
- **Транспорт и обновления:** только wss/TLS. Автообновление клиента и доставка skill-бандлов/конфигов подписаны **Ed25519 — переиспользовать готовую dual-signature-инфраструктуру hak-browser** (подпись на сервере, проверка на клиенте); без валидной подписи клиент не применяет.

---

## 15. Экономия

- **Кеш:** статичный префикс (system + persona-шаблон + определения инструментов) одинаков на всех юзеров → кешируется глобально; юзер-специфика и релевантная память — в первом сообщении. Скиллы кешируются вместе с префиксом. Скидка до 90% на кешируемую часть.
- **TTL кеша 5 минут:** греть осмысленно только внутри активной сессии (диалог, агентская задача). Вне сессий (редкие команды раз в час) — тощий префикс на Haiku, иначе платишь 1.25× за перезапись впустую.
- **Тиры (§7):** Haiku на классификацию/намерения/salience, Sonnet на текст и работу по скиллу, Fable только на разовое освоение. Видно по юз-кейсам (§16): цикл шортсов и отправка — почти целиком локально/$0. Механизм этого «$0» — клиентский skill-runner (§8): при исполнении известного скилла LLM вне цикла вообще.
- **Extended cache TTL 1 час** (запись 2× против 1.25× у 5-минутного): для паттерна «команда раз в 20–60 минут» может выйти дешевле постоянной перезаписи 5-минутного кеша — сравнить на реальном трафике в M2.

---

## 16. Юз-кейсы (приёмочные сценарии)

Для каждого — шаги и **ожидаемое поведение** (критерий «работает»).

**UC-1. Умное напоминание.** «Джарвис, в 9 я должен быть в зале.»
→ Haiku парсит интент → создаётся `intents` (place=gym, deadline=21:00, prep из habits, mode=walking) → планировщик считает `computed_trigger_ts` → пересчёт на гео-событиях → в нужный момент `ProactiveNudge` после salience-проверки.
**Ок, если:** напоминание приходит за (ETA+сборы+буфер) до дедлайна и сдвигается при смене локации; юзер не указывал точное время; «в 9» без утра/вечера дизамбигуируется из habits, при неуверенности Haiku переспрашивает.

**UC-2. Ответ за тебя в VK/Telegram.** «Джарвис, ответь Маше, что буду в 7.»
→ Sonnet сочиняет ответ → `user.confirm.request` («отправляю Маше: …») → после approve → клиентский userbot шлёт через аккаунт юзера → голосовое подтверждение.
**Ок, если:** текст показан до отправки; cadence guard пройден; запись в `outbound_messages` с idempotency.

**UC-3. ТикТок / цикл шортсов.** «Джарвис, включи ТикТок.»
→ (Haiku намерение) → hak-browser открывает TikTok → играет → ловит конец видео → «дальше» → крутит до «стоп».
**Ок, если:** автопереход работает; команда «стоп» прерывает; цикл крутит skill-runner локально — LLM не дёргается ни на одном шаге.

**UC-4. Освоить новый инструмент (Excel).** «Джарвис, сделай таблицу расходов и отформатируй.»
→ нет скилла → Fable-сессия: предпочитает `code.run` (openpyxl), иначе грундит по ролям → на успехе пишет `SKILL.md`.
**Ок, если:** в следующий раз та же задача идёт через skill-runner (LLM — только эскалации и needsLlm-шаги), без повторного Fable-разбора.

**UC-5. Заказ еды.** «Джарвис, закажи как обычно.»
→ скилл заказа (browser/UI) → собирает корзину → spend cap + allowlist → если в пороге и из обычных мест — молча, иначе confirm → чекаут (карта уже привязана, данные не вводятся) → idempotency.
**Ок, если:** дубль-заказ невозможен при retry; превышение порога требует подтверждения; карточные данные не трогаются.

**UC-6. Стиль и память.** Со временем ассистент отвечает в манере юзера и помнит предпочтения (зал пн/ср/пт, обычный заказ).
**Ок, если:** persona отражает наблюдаемый стиль; факты достаются из эпизодической памяти; редактируемый док «о пользователе» правится юзером.

**UC-7. Проактивный контекст.** Открыл приложение/наступает событие календаря → ассистент *иногда* предлагает помощь.
**Ок, если:** salience-фильтр режет несвоевременное; DND соблюдается; нет назойливости.

**UC-8. Дейксис.** Выделен текст в любом окне; «Джарвис, что это значит?»
→ Haiku ловит дейктический маркер → `context.read(selection)` (TextPattern; fallback §19) → ответ голосом.
**Ок, если:** при наличии selection НЕ делается скриншот всего экрана; работает и в браузере, и в нативном приложении; первый звук <2 с.

**UC-9. Веб-вопрос.** «Джарвис, что там нового у Anthropic?»
→ роутер → `web.search` + `web.fetch` на сервере → короткая голосовая выжимка + `ui.display`-карточка с источниками.
**Ок, если:** GUI-браузер юзера не открывался; голосом ≤3 предложений, детали — на экране.

**UC-10. Композитная задача.** «Найди слот с Машей на этой неделе и предложи встретиться.»
→ календарь (свободные слоты) → `contacts` резолвит «Машу» (две Маши → голосовая дизамбигуация) → Sonnet сочиняет → confirm с revise («добавь, что после 19») → отправка с гардами §14.
**Ок, если:** слоты — из реального календаря; revise-петля работает; cadence guard и idempotency на месте.

**UC-11. Отмена и нарративность.** Длинная задача (Excel на 40 шагов); юзер: «стоп».
→ Haiku различает «заткнись» (рубит TTS, задача живёт) и «отмени» (рубит задачу; при неуверенности — «остановить задачу?») → задача `paused`, голосом: «успел A и B — докончить или отменить?»; «продолжи» → resume с текущего шага.
**Ок, если:** актуатор останавливается ≤1 шага; статус в `tasks` консистентен; resume не переделывает сделанное (идемпотентность шагов + verify).

---

## 17. План сборки — вертикальные срезы (КЛЮЧЕВОЕ)

Причина «ничего не работает» — попытка поднять всё сразу. Строить по одному рабочему срезу, каждый отдельно тестируемый и демонстрируемый.

- **M0 — Скелет.** Electron-клиент + WS + server-gateway + эхо. Tier-0 локальные команды («открой приложение»). Ввод текстом (без голоса). *Тест:* текстовая команда → запуск приложения на Windows.
- **M1 — Голосовой цикл.** Wake word + VAD + аудио-стрим + Deepgram STT + Haiku + ElevenLabs TTS + воспроизведение + barge-in + follow-up окно + вербализатор (§21, базовые правила). *Тест:* «Джарвис, который час» → голосовой ответ <800мс до первого слова, перебивание и follow-up работают. Здесь же: bake-off Deepgram на русском, проверка semantic turn detector на RU, валидация wake word «Джарвис».
- **M2 — Роутинг + память.** TS-роутер (тиры), Postgres+pgvector, рабочая + эпизодическая память, persona, кеш-префикс; server-side `web.search`/`web.fetch` (§12); стек сущностей для анафоры (§10). *Тест:* помнит факт из прошлой сессии; простое идёт на Haiku, сложное на Sonnet; UC-9 (веб-вопрос).
- **M3 — Актуаторы + грундинг.** win-сайдкар (UIA-паттерны `ui.invoke` + SendInput-fallback), expect/auto-wait/retry в раннере, user-takeover-пауза, `context.read` (§19), запуск приложений, hak-browser, `code.run` с ограничениями §6. Грундинг по ролям. Каркас задач (taskId + cancel-флаг) закладывается здесь, полная модель — M8. *Тест:* UC-4 (Excel через openpyxl), UC-3 (TikTok базово), UC-8 (дейксис).
- **M4 — Скиллы.** Цикл explore→write SKILL.md→reuse; **клиентский skill-runner**; обучение демонстрацией (§8); ночная консолидация с границами автоправки. *Тест:* вторая попытка идёт через skill-runner и не зовёт ни Fable, ни Sonnet (кроме эскалаций/needsLlm); запись демонстрации конвертируется в рабочий SKILL.md.
- **M5 — Проактивность.** Триггеры, salience, умное напоминание с ETA + геофенс (с мобильным компаньоном-сенсором); busy-сигналы `client.context`; календарь read-only; таблица devices. *Тест:* UC-1; nudge не вторгается в активный созвон.
- **M6 — Переписка.** Userbots GramJS/vk-io + confirm + cadence guard + idempotency; contacts с голосовой дизамбигуацией; revise-петля в confirm. *Тест:* UC-2; UC-10 (композитная — требует календарь из M5).
- **M7 — Заказ еды.** Browser-автоматизация + spend cap + confirm + idempotency + правило карты. *Тест:* UC-5.
- **M8 — Задачи и нарративность.** Полная модель §20: статусы/прогресс, «что делаешь / стоп / продолжи», наррация длинных действий, отчёт пушем отсутствующему юзеру. *Тест:* UC-11.

Параллельный трек: **mobile-компаньон** (Android-first) — гео-сенсор (геофенс) + приёмник пушей; нужен к M5.

---

## 18. Открытые решения / риски

- **win-сайдкар** — самый трудоёмкий интеграционный кусок (UIA-дерево, резолв по ролям, SendInput, DPI). Решение принято: C#/.NET; Node-биндинги к UIA и nut.js не используются (nut.js: пакеты убраны из публичного npm в платный реестр, EULA запрещает редистрибуцию в продукте). Заложить время.
- **Хрупкость видео-фида** (TikTok/YouTube) — нет чистого «видео кончилось» по роли; периодический ремонт. Переписка (a11y) — устойчива, видео — нет; не путать.
- **ToS userbot'ов** — формально серая зона; риск только при нарушении человеческого конверта (§14). VK строже Telegram.
- **Стоимость Fable** в петлях — обязательны max-шагов/токенов и kill-switch.
- **LiveKit Node vs Pipecat (Python)** для voice-оркестрации — начать на LiveKit Agents (Node), Pipecat как fallback-сайдкар, если turn-manager/латентность не вытянут.
- **iOS** — ambient-голос невозможен в фоне; компаньон на iOS = пуши + гео + foreground-голос.
- **Wake word «Джарвис» по-русски** — претрейн openWakeWord `hey_jarvis` английский; русское произношение без «hey» требует валидации и, скорее всего, кастомной модели (openWakeWord — тренировка на синтетике; Porcupine — кастомное слово через консоль). Проверить в M1.
- **Deepgram RU** — качество русского стриминга заранее не гарантировано; bake-off в M1, STT строго за интерфейсом.
- **DPI/мультимонитор** — маппинг vision-координат в SendInput: Per-Monitor V2, виртуальные экранные координаты, скейлинг 125/150%. Багоёмкое место, покрыть интеграционным тестом.
- **Android background location** — для личной сборки/sideload ок; публикация в Play потребует обоснования по политике фоновой геолокации.
- **RU-качество эмбеддингов** — text-embedding-3-small на русском приемлем, но retrieval проверить на своих данных в M2; запасной — self-hosted bge-m3 (поменяется размерность колонки).
- **Голос хозяина** — wake word срабатывает от любого голоса в комнате: «Джарвис, закажи 10 пицц» от гостя. Гарды (confirm на необратимом, spend cap) смягчают; speaker-verification — backlog (§22). Осознанный риск v1.
- **TextPattern не везде** — `context.read(selection)` опирается на UIA TextPattern, который поддержан не всеми приложениями; fallback «Ctrl+C с сохранением/восстановлением буфера» интрузивен, vision — дорог. Снять матрицу поддержки по топ-приложениям юзера в M3.

---

## 19. Контекст экрана и дейксис

То, что юзер видит, — общий контекст разговора по умолчанию. «Что это?», «переведи это», «ответь ему», «сократи вот это» — указательные (дейктические) запросы. Без этого раздела Джарвис — голосовой пульт, а не собеседник; это сценарий №1 настоящего Джарвиса.

**Механика.**
- Haiku-классификатор намерений помечает дейктические маркеры («это», «здесь», «вот», «ему/ей» без антецедента в диалоге) → перед ответом мозг запрашивает `context.read`.
- Приоритет источников, расширение только при пустом предыдущем: `selection` (выделенный текст) → `active_window` (текстовая выжимка видимой области) → `screen` (скриншот + vision; дорого, последним).
- `selection`: UIA TextPattern.GetSelection у активного контрола; для веба в hak-browser — `window.getSelection()` через puppeteer. Fallback там, где TextPattern нет: программный Ctrl+C с сохранением и восстановлением буфера (интрузивно — помечается в action_log) либо vision по кропу bbox контрола.
- `active_window`: заголовок + выжимка a11y-дерева видимой области (роли + имена + value) — НЕ скриншот: дешевле и точнее для текста.
- Анти-паттерн: тащить скриншот всего экрана, когда есть selection.

**Границы (продолжение принципа §0.6).** Никакого непрерывного чтения экрана: `context.read` вызывается только (а) по дейктическому запросу, (б) внутри активной задачи, которой нужен экран. Контент выборки не персистится — в `action_log` пишутся факт вызова и scope, без payload. Окна sensitive-категории (банки, парольные менеджеры — категорийный список) → `context.read` отвечает отказом, мозг честно переспрашивает голосом.

---

## 20. Модель задач: статус, отмена, нарративность

Всё, что длится дольше пары секунд, — **задача** с идентичностью, а не безымянный цикл агента. Иначе «стоп» нечего останавливать, «что ты делаешь?» не на что отвечать, а упавшее на шаге 30 из 40 — чёрный ящик.

- **Сущность** (`tasks`, §13): goal_text, status `queued|running|paused|waiting_confirm|done|failed|cancelled`, прогресс steps_done/steps_total, result_summary. В v1 — один активный `running` на юзера, очередь последовательная; `task.status` стримится на клиент.
- **Голосовое управление** (tier-0/Haiku): «стоп» — Haiku различает по контексту «заткнись» (рубит TTS, задача живёт) и «отмени» (рубит задачу), при неуверенности переспрашивает одним словом («остановить задачу?»); «что делаешь» → статус + прогресс голосом; «продолжи» → resume с текущего шага; «потом доделай» → `paused` + напоминание через §9.
- **Отмена на актуаторе:** runner проверяет cancel-флаг перед каждым шагом; шаг атомарен — прерывание на границе шага (≤1 шаг латентности). Отката нет — есть идемпотентность шагов и verify (§6/§8): resume не переделывает сделанное.
- **Нарративность:** задачи >5 с анонсируются («открываю таблицу, заполню расходы»); вехи — по смене этапа скилла, не по каждому клику; завершение — короткий отчёт + где результат. Тон — §11: без театра, по делу.
- **Юзер ушёл:** нулевая активность на десктопе / активен mobile (presence по `devices`) → отчёт о завершении уходит пушем; голосом в пустую комнату не произносится.
- **Ошибки:** failed объясняется по-человечески («не смог сохранить — файл открыт в другом окне»); технические детали — в `ui.display`; предлагается ровно одно следующее действие («закрыть его и повторить?»).

---

## 21. Голосовой вывод: формат для TTS

LLM-текст нельзя читать вслух как есть. Голос и экран — разные каналы с разными правилами; их смешение убивает «живость» быстрее, чем латентность.

- **Схема вывода мозга:** `{ voice: string; display?: { title?, markdown } }`. Промптом: voice — разговорный синтаксис, ≤3 предложений на простой ответ; ни markdown, ни списков, ни URL, ни код-блоков. Всё длинное и структурное — в display (`ui.display` → карточка в renderer).
- **Вербализатор — детерминированный пост-процессор, не LLM:** числа, даты, время, единицы, валюты — словами с русским согласованием («в 8:20» → «в восемь двадцать», «1500₽» → «полторы тысячи рублей»); телефоны и коды — посимвольно; аббревиатуры — по словарю. LLM просят писать «голосом», но гарантию даёт пост-процессор.
- **Паттерн «кратко голосом — подробно на экране»:** списки («что у меня сегодня») — голосом count + топ-2 + «остальное вывел на экран»; полный список — display-карточкой.
- **Произношение и паузы:** нормализация на стороне ElevenLabs включена; кривые имена собственные — словарь замен в вербализаторе; сырой SSML в текст не сыпать.
- **Ошибки и отказы:** голосом — причина и следующее действие одним предложением; стектрейсы, JSON, коды — только display.

---

## 22. Backlog (v2+) — зафиксировано, чтобы не потерять

- **Кросс-девайс continuity** — начал диалог/задачу на десктопе, продолжил с телефона: общая сессия, handoff контекста.
- **Email** — чтение/триаж/черновики тем же конвейером гардов, что VK/TG.
- **Локальный intent-кеш** — semantic-кеш известных команд на клиенте (эмбеддинг фразы → скилл): мгновенный старт skill-runner без round-trip; инвалидация по версии скилла.
- **Speaker verification («голос хозяина»)** — локальный onnx-эмбеддинг голоса, enrollment при онбординге; чужой голос → только безобидные команды.
- **Quality harness** — телеметрия латентности по стадиям (wake → STT → LLM first token → TTS first chunk → звук), success-rate скиллов по версиям, replay-тесты резолва на записанных a11y-снапшотах: регрессии грундинга ловятся до юзера.
- **Календарь read-write** и бронирования.
- **Мультипользовательская комната** — различение голосов, персональные контексты.
- **Поверхность письма** (камера+OCR / e-ink) — из «не в скоупе» §0, если вообще.

---

## 23. Changelog

### v1.1 → v1.2 — полнота концепции

- **§0:** принцип 6 — privacy-инвариант (аудио/экран не покидают машину без активации); в скоуп v1 добавлены дейксис, веб-вопросы, модель задач.
- **§19 (новый):** контекст экрана и дейксис — `context.read(selection|active_window|screen)`, приоритет источников, sensitive-окна, непersisting.
- **§20 (новый):** модель задач — `tasks`, «стоп/что делаешь/продолжи» с различением «заткнись»≠«отмени», отмена ≤1 шага, нарративность, отчёт пушем отсутствующему юзеру.
- **§21 (новый):** голосовой вывод — схема `{voice, display}`, детерминированный RU-вербализатор, «кратко голосом — подробно на экране».
- **§22 (новый):** backlog v2+ — continuity, email, intent-кеш, speaker verification, quality harness и др.
- **§6:** UIA-паттерны (`ui.invoke`) — основной путь действия, SendInput — fallback (действия без захвата курсора, в фоновом окне); арбитраж ввода — user takeover → пауза задачи; `expect`/auto-wait/retry у шагов; `context.read` и `demo.record` в ActionCommand.
- **§8:** verify-шаг скилла (постусловие всей задачи); обучение демонстрацией («смотри, покажу»: UIA-события + голосовой комментарий → SKILL.md через Fable, с ревью guard-шагов).
- **§12/§1:** server-side веб-знания (`web.search`/`web.fetch`) — Q&A не трогает GUI-браузер юзера; календарь read-only за `ICalendarProvider`.
- **§10:** follow-up окно (~6 с без повторного wake word); стек сущностей для анафоры между репликами и задачами.
- **§11:** персона самого Джарвиса как версионируемый артефакт (`persona.md`); зеркалирование юзера — поверх, не вместо.
- **§9:** занятость как вход salience (`client.context`: созвон/fullscreen/lock); presence-роутинг по `devices`.
- **§13:** + `contacts` (дизамбигуация, `contact_id` в outbound), + `devices`, + `tasks`; `task_id` в action_log.
- **§5:** + `client.context`, `demo.event`, `task.status`, `ui.display`; `revision` в ConfirmResult — revise-петля в confirm (§14).
- **§16:** UC-8 (дейксис), UC-9 (веб-вопрос), UC-10 (композитная: календарь+контакты+revise), UC-11 (отмена/нарративность).
- **§17:** новое распределено по M1–M6; добавлен M8 (задачи/нарративность).
- **§18:** риски — голос хозяина, покрытие TextPattern.

### v1 → v1.1 — корректность и дыры

- **nut.js удалён** (пакеты вне публичного npm, EULA запрещает редистрибуцию) → ввод через SendInput в едином C# win-сайдкаре (UIA + ввод в одном процессе); сайдкар вынесен в `apps/sidecar-win`.
- **Выбран провайдер эмбеддингов** — OpenAI text-embedding-3-small (у Anthropic нет embeddings API); индекс ivfflat → HNSW (ivfflat на пустой таблице бессмыслен).
- **Схема:** `usage_quota` PK → `(user_id, period)` (был баг: одна строка на юзера); убран дублирующий `confirmed bool` в orders/outbound; `UNIQUE(user_id, label)` у places; добавлена таблица `action_log` (источник консолидации и дебага); канонический источник скилла — `content_md`, `steps` — derived.
- **Протокол:** определён `ActionResult`; handshake + версионирование протокола; heartbeat; семантика реконнекта для команд in-flight; `timeoutMs` у команд; `expiresAt` у nudge и confirm (просроченный nudge не произносится); решение по аудио — только LiveKit/WebRTC, WS = control plane.
- **Введён клиентский skill-runner (tier-0.5):** детерминированное исполнение шагов известного скилла без LLM, эскалация только на fail/needsLlm — устранено противоречие §8↔§15 («$0 на шортсах» при «Sonnet на каждый шаг»).
- **code.run:** определены реальные ограничения (Job Object, сетевой запрет per-process, CWD=temp, серверный lint-гард; powershell — всегда confirm + CLM).
- **Голос:** штатный semantic turn detector LiveKit (Node, мультиязычный) вместо кастомного turn-manager'а; `voice/` — отдельный процесс со стабильным контрактом (swap на Pipecat = замена процесса). Аудио-захват/воспроизведение перенесены в renderer — иначе WebRTC AEC не режет собственный TTS и barge-in не работает.
- **Консолидация:** guard-шаги protected от автоправки; новая версия активируется после успешного прогона; авто-rollback по fail_count.
- **Userbots:** явный контракт данных (метаданные по умолчанию, полный тред по требованию, контент не персистится) — убрана вводящая в заблуждение формулировка «приватнее»; секреты — Electron safeStorage/DPAPI.
- **Безопасность:** wss/TLS; подпись автообновлений и skill-бандлов Ed25519 (переиспользование dual-signature-инфраструктуры hak-browser); ревью свежевыученного скилла с guard-шагами.
- **Риски:** добавлены wake word RU, Deepgram RU, DPI/мультимонитор, Android background location, RU-эмбеддинги.
