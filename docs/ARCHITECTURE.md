# ARCHITECTURE — Архитектура Jarvis

> Спецификация: §1, §3–§12, §15 docs/JARVIS_SPEC.md

---

## Три потока (§1)

```
┌─────────────────────────────────────────────────────────────────┐
│                        КЛИЕНТ (Electron)                        │
│                                                                 │
│  [renderer]                  [main]                             │
│  микрофон ─►─────────────► audio/ ──► wakeword/ ──►─────────┐  │
│  воспроизведение ◄──────── audio/     vad/                   │  │
│  орб/UI/confirm             sensors/   transport/ ◄──────────┘  │
│                             actuators/             │            │
│                             sidecar-win IPC ◄──────┤            │
│                             tier0/                 │            │
│                             skill-runner/           │            │
└─────────────────────────────┼──────────────────────┼────────────┘
                              │ WebSocket (control)  │
                              │ WebRTC (аудио)       │
                              ▼                      │
┌─────────────────────────────────────────────────────────────────┐
│                       СЕРВЕР (Ubuntu)                           │
│                                                                 │
│  gateway/ ──► brain/router/ ──► brain/agent/ ──► brain/persona/ │
│                   │               │                             │
│              [тир Haiku]    [tool calls]    memory/working.ts   │
│              [тир Sonnet]   [ActionCommand] memory/episodic.ts  │
│              [тир Fable]    [ActionResult]  memory/skills.ts    │
│                                   │                             │
│  proactive/ ──► salience/ ────────┘    billing/ (spend cap)     │
│  scheduler/    triggers/               integrations/            │
│  consolidation/ (ночной крон)                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Поток 1: Голос (§10)

```
микрофон (renderer)
  │
  ├─► wakeword/ (локально, onnx) ──► "Джарвис" → активировать стрим
  │
  ▼
audio/ (main) ──IPC─► VAD (Silero, локально)
  │                   │ speech_start / barge_in / speech_end
  │                   ▼
  └──► LiveKit WebRTC ──► server voice/
                               │
                          streaming STT (Deepgram)
                               │
                          turn detector (LiveKit semantic)
                               │
                          brain/ (router → agent)
                               │
                          streaming TTS (ElevenLabs)
                               │
                          LiveKit WebRTC ──► воспроизведение (renderer)
```

Цель первого звука — < 800 мс от конца фразы. Схема: interim-транскрипт → старт LLM → стримить токены → TTS первый чанк после первого предложения. Полный ответ не ждём. (§10)

**Barge-in:** микрофон горячий во время TTS (full-duplex); WebRTC AEC в renderer режет собственный TTS.

**Follow-up окно:** ~6 с после конца TTS — продолжение без повторного wake word. (§10)

### Поток 2: Действие (§6)

```
brain/agent/ решает действие
  │
  ▼ ActionCommand (по WS, control plane)
  │
apps/client/main/actuators/
  │
  ├─► tier0/ ──► детерминированно, $0 (app.launch, app.focus, ...)
  │
  ├─► skill-runner/ ──► шаги SKILL.md без LLM (tier-0.5)
  │                     ├─► sidecar-win IPC (UIA-паттерны, SendInput)
  │                     ├─► hak-browser (puppeteer-core)
  │                     └─► code-runner.ts (изолированный раннер)
  │
  └─► [эскалация] ──► сервер (Sonnet или Fable)

ActionResult (по WS, control plane) ──► brain/agent/
```

### Поток 3: Проактивность (§9)

```
server proactive/triggers/
  ├─► Время (cron, intents.computed_trigger_ts)
  ├─► Контекст (client.context — активное окно)
  └─► Внешние (календарь, завершённый процесс)
        │
        ▼
  salience/ (Haiku) ─── client.context (busy? DND?)
        │
        ▼ (если уместно)
  ProactiveNudge ──► клиент (renderer произносит сам, если не истёк expiresAt)
        │
        └─► (если клиент offline) FCM пуш ──► mobile/android
```

---

## Тонкий клиент / толстый сервер (§0, принцип 1)

Клиент исполняет, сервер думает:

| Что на клиенте | Что на сервере |
|---|---|
| Захват аудио (renderer) | STT, LLM, TTS |
| Wake word, VAD (main, локально) | Роутинг тиров, агент, память |
| Actuators: исполнение команд | Генерация ActionCommand |
| Skill-runner (tier-0.5, без LLM) | Explore/write SKILL.md (Fable) |
| Userbot-сессии (safeStorage) | Контент на сервер по требованию |
| Геофенс-сенсор (Android) | Пересчёт computeTriggerTs |
| Confirm-модалка | Генерация текста подтверждения |

Клиент у всех пользователей идентичен. Вся персонализация — per-user на сервере.

---

## Грундинг по a11y, не по координатам (§0, принцип 2; §6)

**Порядок резолва цели:**

```
1. UIAutomation (sidecar-win)
   role="button", name="Отправить"
        │ нашли handle
        ▼
   UIA-паттерн (ui.invoke): InvokePattern, ValuePattern, TogglePattern...
   Действие без захвата курсора — юзер продолжает пользоваться ПК
        │ паттерн не поддержан
        ▼
   SendInput (мышь/клавиша по handle + bbox)

2. hak-browser (для веба)
   ARIA accessibility-дерево puppeteer
        │ a11y пуст (видео-канвас)
        ▼
   Клавиатурные аффордансы: Space, стрелки

3. Vision fallback (дорого, только если 1–2 не дали)
   Скриншот → LLM vision → координаты
   Маппинг в SendInput: Per-Monitor DPI V2, виртуальные координаты
```

**Скилл хранит намерение в терминах ролей/интентов — никогда не пиксели и не CSS-селекторы.** (§8)

---

## Протокол как шов (§5)

`packages/protocol` — единственный контракт между клиентом и сервером.

```
Envelope<T> = { id: string; ts: number; type: MessageType; payload: T }
```

Brain не знает про puppeteer/UIA — он эмитит абстрактные `ActionCommand`.
Клиент не знает про LLM — он исполняет `ActionCommand` и возвращает `ActionResult`.

**Семантика соединения:**
- Heartbeat: ping/pong каждые 15 с; два пропуска → реконнект (§5)
- Реконнект: `client.hello` с `resumeSessionId`; in-flight команды доисполняются, результаты буферизуются
- Таймауты: каждый `ActionCommand` несёт `timeoutMs`; сервер идемпотентен к повторной доставке result
- Версионирование: несовпадение мажора `protocolVersion` → ошибка, клиент показывает «требуется обновление»

---

## Память (§8)

Три хранилища, все per-user:

```
┌─────────────────────────────────────────────────────────────────┐
│ Рабочая (working.ts)                                            │
│ Кольцевой буфер сессии, живёт в окне модели.                   │
│ Персистится в таблице messages.                                 │
├─────────────────────────────────────────────────────────────────┤
│ Эпизодическая (episodic.ts)                                     │
│ Факты / предпочтения / события пользователя.                    │
│ PostgreSQL + pgvector: embedding vector(1536), HNSW-индекс.     │
│ Поля: salience, stale, last_used_at.                            │
│ Провайдер: OpenAI text-embedding-3-small.                       │
├─────────────────────────────────────────────────────────────────┤
│ Процедурная (skills.ts)                                         │
│ SKILL.md per-user: шаги в терминах ролей/интентов.             │
│ content_md — канонический источник; steps — derived-парс.       │
│ Версионируется (version, success_count, fail_count).            │
└─────────────────────────────────────────────────────────────────┘
```

**Ночная консолидация** (§8): Haiku по `action_log` → дедуп скиллов, починка ошибок, чистка stale.
Guard-шаги (`message.send`, `code.run`, confirm) — консолидация не трогает.

---

## Тиры (§7)

```
Tier 0   ─── Локально ($0)    app.launch, app.focus, tier0/ детерминированные
Tier 0.5 ─── skill-runner ($0) детерминированное исполнение шагов SKILL.md без LLM
Tier 1   ─── Haiku            намерения, классификация, salience, simple Q&A
Tier 2   ─── Sonnet           текст, инструменты, анализ, веб-синтез
Tier 3   ─── Fable            разовое освоение нового GUI, vision-планирование
```

Каскад: пытаться снизу вверх. Для голоса — Haiku-классификатор выбирает тир **до** генерации (не retry). (§7)

Экономия: известный скилл исполняет skill-runner без LLM → цикл шортсов «дальше» стоит $0. (§15)

---

## Экономия кеша (§15)

```
Системный промпт (статичный):
  ┌─ prefix ────────────────────────────────────────────────────┐
  │ Persona-шаблон + определения инструментов                  │
  │ Одинаков для ВСЕХ юзеров → кешируется глобально.           │
  │ Скидка до 90% на кешируемую часть.                         │
  └─────────────────────────────────────────────────────────────┘
  ┌─ first message (per-user) ──────────────────────────────────┐
  │ Динамика юзера: персона, стиль, релевантная память,        │
  │ активные скиллы.                                            │
  └─────────────────────────────────────────────────────────────┘
```

TTL кеша 5 минут: греть только внутри активной сессии.
Вне сессий (редкие команды раз в час) — тощий prefix на Haiku. (§15)

---

## Безопасность и приватность (§0, §14)

Краткие принципы — детально в [SECURITY.md](SECURITY.md):

- Аудио не покидает машину без wake word / явной активации
- Непрерывного чтения экрана нет: `context.read` только по дейктическому запросу или в активной задаче
- Контент переписки на сервере не персистится дольше рабочей памяти
- Userbot-сессии на клиенте (Electron safeStorage / DPAPI), не на сервере
- Транспорт: только wss/TLS
- Автообновления и skill-бандлы подписаны Ed25519 (dual-signature, §14)
