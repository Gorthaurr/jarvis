# Jarvis — персональный голосовой ассистент (v0.1)

> Полная техническая спецификация: [docs/JARVIS_SPEC.md](docs/JARVIS_SPEC.md)

## Что это

**Jarvis** — персональный голосовой ассистент с управлением Windows-компьютером:
ambient-голос (всегда слушает по wake word), управление компьютером через Windows UIAutomation,
переписка от лица пользователя в VK/Telegram, проактивный планировщик с умными напоминаниями,
обучение новым GUI-инструментам с переиспользованием выученного.

**Мозг выбирается настройкой `LLM_PROVIDER`:** Codex через существующий ChatGPT login, локальный Ollama
или прежний Claude. Новые профили не требуют покупки LLM API-ключа; Codex использует общие лимиты подписки.
Смена мозга сохраняет голос, распознавание, подтверждения и исполнение команд в Jarvis.
Текущая карта проекта — [CLAUDE.md](CLAUDE.md), механика и проверенные команды — [HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

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
| Wake word | sherpa-onnx KWS (локально) |
| VAD | Silero VAD (onnxruntime, локально) |
| Ввод (мышь/клава) | SendInput через C#-сайдкар |
| Windows a11y + ввод | `apps/sidecar-win` (C#/.NET, UIAutomation + SendInput) |
| Сервер | Node + Fastify |
| Голосовой пайплайн | Собственный WS/PCM, wake-гейт и отмена |
| STT | Настроенный Deepgram; опционально локальный Whisper |
| TTS | Настроенный Yandex/ElevenLabs; опционально Windows SAPI |
| LLM | Codex App Server / Ollama / прежний Claude |
| Эмбеддинги | Локальная e5-small или настроенный OpenAI, 384d |
| БД | PostgreSQL + pgvector, для отдельного личного профиля PGlite |
| Очереди/таймеры | PG + node-cron |

---

## Личный запуск без нового ключа LLM

```powershell
# Зависимости и клиент
pnpm install
pnpm --filter @jarvis/client build
dotnet publish apps/sidecar-win/SidecarWin.csproj -c Release

# Codex CLI должен быть установлен; вход именно через ChatGPT
codex login

# Отдельные данные и сервер на 8788; прежний .env не меняется
powershell -ExecutionPolicy Bypass -File infra/run-no-api.ps1 -Brain codex

# В другом PowerShell, закрыв предыдущий экземпляр клиента
$env:PORT='8788'
pnpm --filter @jarvis/client start
```

Запускатель переносит прежние STT/TTS из `.env`, включая голос, скорость и ключи аудиосервисов. Явный
`-OfflineAudio` выбирает Whisper/Windows TTS. `-Brain local` выбирает установленный Ollama с моделью
`qwen3.5:9b-q4_K_M` (подробности установки и портов — HOW_IT_WORKS §1a).
Для перехода существующего основного профиля достаточно `LLM_PROVIDER=codex` и `CODEX_MODEL=gpt-6-luna`
в его `.env`, с перезапуском сервера; данные и аудионастройки остаются прежними.

---

## Проверки

`pnpm verify` объединяет typecheck, размерные гейты, тесты пакетов и лаборатории, настоящее расширение Chromium
и пятикратный прогон изменённых тестов. Для расширения нужен `CHROME_PATH`. Платные live-проверки Deepgram
включаются только явно. Состав и ограничения — [VERIFY.md](docs/lab/VERIFY.md).
Живые проверки моделей, микрофона и настоящего клиента находятся в `infra/lab/no-api`; различия между
виртуальным ПК, аудиофайлом и настоящим Electron-клиентом описаны в HOW_IT_WORKS §1a.

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
