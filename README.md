# Jarvis — персональный голосовой ассистент (v0.1)

> Полная техническая спецификация: [docs/JARVIS_SPEC.md](docs/JARVIS_SPEC.md)

## Что это

**Jarvis** — персональный голосовой ассистент с управлением Windows-компьютером:
ambient-голос (всегда слушает по wake word), управление компьютером через Windows UIAutomation,
переписка от лица пользователя в VK/Telegram, проактивный планировщик с умными напоминаниями,
обучение новым GUI-инструментам с переиспользованием выученного.

**Весь интеллект — через облачное API.** Никаких локальных LLM внутри установщика.
Малые onnx-модели (wake word, VAD) — единицы МБ, не в счёт. (§0 спецификации)

---

## Архитектурные принципы (§0, нарушать нельзя)

1. **Тонкий клиент / толстый сервер.** Клиент только захватывает (аудио, экран) и исполняет (актуаторы). Вся логика и состояние — на сервере.
2. **Грундинг по доступности, не по координатам.** Актуатор находит контролы по роли/имени в Windows UIAutomation / Chromium accessibility. Пиксели — только vision-fallback.
3. **Человеческий конверт поведения.** Все действия от лица пользователя держатся в человеческом темпе: rate-limit, джиттер, никакого веера по получателям.
4. **Подтверждение необратимого.** Отправка сообщений, заказы выше порога — явное подтверждение через модалку или голос.
5. **Карту не трогаем.** Агент никогда сам не вводит, не хранит и не редактирует карточные/платёжные данные. Жёсткая красная линия.
6. **Ничего не покидает машину без активации.** Аудио стримится на сервер только после wake word; непрерывного чтения экрана нет.

---

## Стек (§1)

| Слой | Выбор |
|---|---|
| Монорепо | pnpm + TypeScript (target ES2022) |
| Клиент | Electron + electron-builder → `.exe` |
| Wake word | openWakeWord / Porcupine (локально) |
| VAD | Silero VAD (onnxruntime, локально) |
| Ввод (мышь/клава) | SendInput через C#-сайдкар |
| Windows a11y + ввод | `apps/sidecar-win` (C#/.NET, UIAutomation + SendInput) |
| Сервер | Node + Fastify |
| Голосовой пайплайн | LiveKit Agents (Node) |
| STT | Deepgram (streaming) |
| TTS | ElevenLabs (streaming) |
| LLM | Anthropic SDK (тиры tier0/Haiku/Sonnet/Fable) |
| Эмбеддинги | OpenAI text-embedding-3-small (1536d) |
| БД | PostgreSQL + pgvector |
| Очереди/таймеры | PG + node-cron |

---

## Как поднять dev-окружение

```bash
# 1. Установить зависимости
pnpm install

# 2. Поднять инфраструктуру (PostgreSQL + pgvector)
docker compose -f infra/docker-compose.yml up -d

# 3. Применить миграции
pnpm db:migrate

# 4. Запустить сервер
pnpm dev:server

# 5. Запустить Electron-клиент
pnpm dev:client
```

Переменные среды — скопировать `.env.example` в `.env` и заполнить ключи API.

---

## Проверка M0 (текущий рабочий срез)

1. Запустить `pnpm dev:server` и `pnpm dev:client`.
2. В окне клиента ввести текстом: `открой блокнот`.
3. Ожидаемый результат: на Windows запускается `notepad.exe`, сервер присылает `action.command` с `kind:"app.launch"`, клиент исполняет и отвечает `action.result{ok:true}`.

Голос, память, скиллы и остальные возможности — в следующих milestone'ах (M1..M8). Подробнее в [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

---

## Структура репозитория (§2)

```
jarvis/
├── apps/
│   ├── client/          # Electron, Windows — единственный установщик
│   │   ├── main/        # main-процесс: actuators, transport, tier0, wakeword, vad, ...
│   │   └── renderer/    # UI (орб, confirm-модалка, карточки) + захват/воспроизведение аудио
│   ├── sidecar-win/     # C#/.NET: UIA-грундинг + SendInput; IPC stdio/named pipe
│   ├── server/          # мозг на Ubuntu
│   │   ├── gateway/     # auth, per-user сессия, WS-хаб
│   │   └── brain/       # router + agent + persona
│   └── mobile/          # Android: геофенс-сенсор + FCM-пуши
├── packages/
│   ├── protocol/        # контракт WS клиент↔сервер (Envelope, MessageType, ActionCommand)
│   ├── shared/          # утилиты (Result, Logger, sleep, env, тиры)
│   └── tools/           # JSON-схемы инструментов мозга
├── infra/               # docker-compose, миграции PostgreSQL
└── docs/                # BUILD_PLAN, ARCHITECTURE, STATUS, SECURITY
```

---

## Статус: что работает / что скелет

Подробная таблица компонентов — в [docs/STATUS.md](docs/STATUS.md).

**Реально работает (M0-каркас):**
- Монорепо pnpm + TS: сборка и типы без ошибок
- `packages/protocol` — полный типизированный контракт (§5/§6): Envelope, MessageType, ActionCommand, все типы сообщений
- `packages/shared` — утилиты: Result, Logger, sleep/jitter/backoff, env-хелперы, тиры
- `packages/tools` — JSON-схемы инструментов
- `infra/` — миграции PostgreSQL (все таблицы §13) + docker-compose + раннер
- `apps/server/gateway` — WS handshake, heartbeat, reconnect, in-flight, таймауты (§5)
- `apps/server/brain/router` — скелет classifyTier (§7)
- `apps/server/brain/agent` — M0-агент: `dev.text` "открой X" → `app.launch` round-trip
- `apps/server/brain/persona` — сборка persona-промпта + вербализатор §21 (детерминированный, с тестами)
- `apps/server` — рабочая память, billing limits (spend cap §14), scheduler.computeTriggerTs (§9)
- `apps/client/main/actuators` — `app.launch` + `app.focus` (реальные, запускают приложения)
- `apps/client/main/tier0` — детерминированные команды без сети
- `apps/client/main/transport` — WebSocket к серверу
- `apps/client/renderer` — текстовый ввод + confirm-модалка
- `apps/sidecar-win/` — компилируемый C#-скелет UIAutomation + SendInput (интерфейс готов)
- `apps/mobile/android` — скелет: геофенс + FCM (интерфейсы готовы)

**Скелет / TODO по milestone'ам (§17):**
- M1: голос (wake word, VAD, STT Deepgram, TTS ElevenLabs, LiveKit)
- M2: память-retrieval (pgvector episodic), роутинг тиров
- M3: UIA-актуаторы (полный `ui.invoke`, SendInput, code.run)
- M4: скиллы + skill-runner + консолидация
- M5: проактивность + геофенс + мобильный компаньон
- M6: переписка (GramJS/vk-io + cadence guard + userbots)
- M7: заказы еды
- M8: задачи и нарративность (§20)
