# STATUS — Состояние компонентов

> Легенда: ✅ работает | 🟡 скелет / stub / TODO | ⬜ не начато

---

## Инфраструктура монорепо

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| pnpm workspaces | M0 | ✅ работает | `pnpm-workspace.yaml`, `package.json` |
| tsconfig.base.json | M0 | ✅ работает | `tsconfig.base.json` |
| .gitignore / .npmrc / .env.example | M0 | ✅ работает | корень |
| docker-compose (PostgreSQL + pgvector) | M0 | ✅ работает | `infra/docker-compose.yml` |
| Миграции PostgreSQL (все таблицы §13) | M0 | ✅ работает | `infra/migrations/0001_init.sql`, `0002_seed_dev.sql` |
| Раннер миграций | M0 | ✅ работает | `infra/migrate.mjs` |

---

## packages/protocol

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Envelope<T>, makeEnvelope, newId, isEnvelope | M0 | ✅ работает | `packages/protocol/src/index.ts` |
| MessageType (полный union) | M0 | ✅ работает | `packages/protocol/src/messages.ts` |
| ActionCommand (полный union) | M0 | ✅ работает | `packages/protocol/src/actions.ts` |
| Константы: PROTOCOL_VERSION, HEARTBEAT_*, таймауты | M0 | ✅ работает | `packages/protocol/src/constants.ts` |
| Все типы сообщений: Hello, ClientState, SpeakChunk, Transcript, TaskStatus, DisplayCard, ... | M0 | ✅ работает | `packages/protocol/src/messages.ts` |

---

## packages/shared

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Result<T,E>, ok, err | M0 | ✅ работает | `packages/shared/src/index.ts` |
| sleep, humanJitter, backoffMs | M0 | ✅ работает | `packages/shared/src/index.ts` |
| env, envInt, envOptional | M0 | ✅ работает | `packages/shared/src/index.ts` |
| createLogger, Logger, LogLevel, LatencyStage | M0 | ✅ работает | `packages/shared/src/index.ts` |
| Tier, TIER_MODEL_ENV, DEFAULT_MODELS | M0 | ✅ работает | `packages/shared/src/index.ts` |

---

## packages/tools

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| JSON-схемы инструментов мозга | M0 | ✅ работает | `packages/tools/src/index.ts` |

---

## apps/server — gateway

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| WS handshake (client.hello / server.hello) | M0 | ✅ работает | `apps/server/src/gateway/session.ts` |
| Heartbeat (ping/pong, 15 с, 2 пропуска → reconnect) | M0 | ✅ работает | `apps/server/src/gateway/heartbeat.ts` |
| Reconnect (resumeSessionId, in-flight буфер) | M0 | ✅ работает | `apps/server/src/gateway/session.ts` |
| ActionCommand timeout | M0 | ✅ работает | `apps/server/src/gateway/session.ts` |
| Registry сессий | M0 | ✅ работает | `apps/server/src/gateway/registry.ts` |

---

## apps/server — brain

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| router / classifyTier (§7, Unicode-границы RU) | M0/M2 | ✅ работает | `brain/router/index.ts` (тест 9/9) |
| agent-loop (tier0 + tool-use + retrieval + предохранитель) | M2 | ✅ работает | `brain/agent/index.ts` (тест 4/4) |
| persona (сборка system-промпта, кешируемый префикс §15) | M0 | ✅ работает | `brain/persona/index.ts` |
| persona.md (характер Джарвиса, §11) | M0 | ✅ работает | `brain/persona/persona.md` |
| Вербализатор §21 (детерминированный RU-постпроцессор) | M0 | ✅ работает | `brain/verbalize/` (тест 13/13) |
| LLM-провайдер с tool-use (Anthropic real + Mock) | M2 | ✅ работает | `integrations/llm.ts`, `anthropic.ts` |
| ToolDispatcher (актуаторы + web/memory; send/order → M6/M7) | M2 | ✅ работает | `brain/tools/dispatch.ts` |
| code.run lint-гард (реестр/службы/сеть/пути; powershell→confirm §6) | M3 | ✅ работает | `brain/code-guard.ts` (тест 6/6) |
| web.search / web.fetch (Brave + readability §12) | M2 | ✅ работает | `integrations/web.ts` (тест 5/5, real+mock) |

---

## apps/server — memory

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Working memory (кольцевой буфер + стек анафоры §10) | M0/M2 | ✅ работает | `memory/working.ts` |
| Episodic memory (pgvector + in-memory + retrieval §8) | M2 | ✅ работает | `memory/episodic.ts` (тест 4/4) |
| Эмбеддинги (OpenAI 1536 + Hash детерм. для dev) | M2 | ✅ работает | `integrations/openai-embeddings.ts` |
| Skills CRUD + parseSkillMd/serializeSkill (round-trip §8) | M4 | ✅ работает | `memory/skills.ts` (тест 6/6) |
| Обучение демонстрацией (DemoEvent→SKILL.md черновик §8) | M4 | ✅ работает | `brain/skills/demo.ts` (тест 3/3) |
| Консолидация: границы автоправки (guard-frozen/promote/rollback §8) | M4 | ✅ работает | `consolidation/index.ts` (тест 4/4) |
| Ночная суммаризация эпизодов (LLM) | M4 | 🟡 скелет | `nightlyConsolidation` — каркас (нужен LLM) |
| skill.execute на клиенте (skill-runner + client-actuator) | M4 | ✅ работает | `client/main/skill-runner/` |

---

## apps/server — proactive / scheduler / billing

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| scheduler: computeTriggerTs + scheduleReminder + learnedPrepMs (§9) | M0/M5 | ✅ работает | `proactive/scheduler.ts` (тест 6/6) |
| Billing limits / spend cap / kill-switch (§14) | M0 | ✅ работает | `billing/index.ts` |
| salience: busy/DND/fullscreen/критический + NudgeQueue (§9) | M5 | ✅ работает | `proactive/salience.ts` (тест 8/8) |
| presence-роутинг (десктоп-голос / mobile-пуш §9, §20) | M5 | ✅ работает | `proactive/presence.ts` (тест 4/4) |
| Триггеры (time/context/external) — модель + источники | M5 | 🟡 скелет | `proactive/triggers/` (cron/watcher — позже) |
| ETA (Yandex/OSRM за IEtaProvider) | M5 | 🟡 скелет | `integrations/maps.ts` (стаб 20мин) |
| ICalendarProvider (read-only §12) | M5 | 🟡 скелет | `integrations/calendar.ts` |

---

## apps/server — DB

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Pool PostgreSQL | M0 | ✅ работает | `apps/server/src/db/pool.ts` |
| action_log (записи ActionCommand/Result) | M0 | ✅ работает | `apps/server/src/db/action-log.ts` |

---

## apps/client — main

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| actuators/apps.ts (app.launch + app.focus) | M0 | ✅ работает | `apps/client/main/actuators/apps.ts` |
| actuators/browser.ts (hak-browser стаб) | M3 | 🟡 скелет | `apps/client/main/actuators/browser.ts` |
| actuators/code-runner.ts (CWD=temp, таймаут, лимит вывода, urезанный env) | M3 | ✅ работает | `code-runner.ts` (Job Object — TODO) |
| actuators/sidecar-client.ts (JSON-line RPC к sidecar) | M3 | ✅ работает | тест 5/5 (фрейминг/корреляция/таймаут) |
| actuators/ground.ts (ui.ground/ui.invoke/context.read через sidecar) | M3 | ✅ работает | реальный IPC; деградация без exe |
| actuators/input.ts (type/key/click через sidecar SendInput) | M3 | ✅ работает | aligned с C#-протоколом |
| tier0/ (детерминированные команды, $0) | M0 | ✅ работает | `apps/client/main/tier0/index.ts` |
| transport/ (WebSocket к серверу) | M0 | ✅ работает | `apps/client/main/transport/` |
| wakeword/ (детектор «Джарвис») | M1 | ✅ работает | mock + push-to-talk; onnx openWakeWord опц. (RU-валидация §18) |
| vad/ (Silero VAD) | M1 | ✅ работает | энергетический VAD (RMS+hangover); Silero/onnx опц. |
| audio/ (координация: PCM → wakeword/vad, гейтинг стрима) | M1 | ✅ работает | privacy-гейт + barge-in, тест 5/5 |
| sensors/ (screenshot, active-window) | M3 | 🟡 скелет | `apps/client/main/sensors/` |
| skill-runner/ (интерпретатор шагов: expect/auto-wait/retry/cancel/escalate) | M3/M4 | ✅ работает | `skill-runner/index.ts` (тест 5/5) |

---

## apps/client — renderer

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Текстовый ввод (dev.text) | M0 | ✅ работает | `apps/client/renderer/` |
| Confirm-модалка (user.confirm.request) | M0 | ✅ работает | `apps/client/renderer/` |
| Аудио-захват/воспроизведение (getUserMedia + AudioWorklet + WebAudio) | M1 | ✅ работает | `renderer/audio.ts`, `audio-worklet.js` |
| Орб (idle/listening/thinking/speaking) | M1 | ✅ работает | + push-to-talk по клику |
| DisplayCard (ui.display карточки §21) | M8 | ✅ работает | `renderer.ts` addCard (markdown как текст) |
| Task progress (task.status стрим §20) | M8 | ✅ работает | панель `#taskPanel` + кнопки стоп/пауза/продолжить |
| task.control (стоп/пауза/продолжить из UI) | M8 | ✅ работает | preload/main/transport → `task.control` |

---

## apps/sidecar-win (C#/.NET)

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Скелет: Program.cs, IPC stdio | M0 | 🟡 скелет | `apps/sidecar-win/Program.cs`, `Ipc.cs` |
| UIAutomation-грундинг (UiaGrounder.cs) | M3 | 🟡 скелет | `apps/sidecar-win/UiaGrounder.cs` |
| SendInput-синтез (InputSynthesizer.cs) | M3 | 🟡 скелет | `apps/sidecar-win/InputSynthesizer.cs` |
| UIA-паттерны (InvokePattern, ValuePattern, ...) | M3 | ⬜ не начато | TODO(M3) |
| Арбитраж ввода (user takeover) | M3 | ⬜ не начато | TODO(M3) |

---

## apps/mobile (Android)

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Скелет Android-приложения | parallel | 🟡 скелет | `apps/mobile/android/` |
| Геофенс (Android Geofencing API) | M5 | 🟡 скелет | TODO(M5) |
| FCM data-сообщения (ProactiveNudge) | M5 | 🟡 скелет | TODO(M5) |
| Валидация expiresAt на устройстве | M5 | ⬜ не начато | TODO(M5) |

---

## apps/server — voice (§10)

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| VoicePipeline (STT→brain→TTS, in-process; контракт IVoiceProcess для выноса в LiveKit/Pipecat) | M1 | ✅ работает | `apps/server/src/voice/pipeline.ts` |
| Машина состояний (idle/listening/thinking/speaking) | M1 | ✅ работает | `voice/state.ts` (+тест 15/15) |
| Turn detection (семантический эндпоинтинг поверх VAD) | M1 | ✅ работает | `voice/turn.ts` (+тест 8/8) |
| Latency-инструментирование (<800мс §10) | M1 | ✅ работает | `voice/latency.ts` (+тест 4/4) |
| Deepgram streaming STT (subprotocol-auth, парсер) | M1 | ✅ работает | `integrations/deepgram.ts` (real+mock) |
| ElevenLabs streaming TTS (stream-input WS) | M1 | ✅ работает | `integrations/elevenlabs.ts` (real+mock) |
| Barge-in + follow-up окно (§10) | M1 | ✅ работает | `voice/pipeline.ts` (+тест 4/4) |
| Реальный мик-end-to-end (нужны ключи + LiveKit/WebRTC бинарь аудио) | M1 | 🟡 частично | unit+smoke ок; live-аудио по WS — dev (§5) |

---

## apps/server — интеграции (M6–M7)

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| userbots: ISender + MockSender + Telegram/VK адаптеры (§12) | M6 | ✅ работает | `packages/userbots` (сессия на клиенте) |
| Cadence guard (rate-limit/веер/burst/новый контакт §14) | M6 | ✅ работает | `brain/messaging/cadence.ts` (тест 5/5) |
| Контакты + голосовая дизамбигуация (§13) | M6 | ✅ работает | `brain/messaging/contacts.ts` (тест 6/6) |
| Outbound: confirm + revise-петля + idempotency (UC-2) | M6 | ✅ работает | `brain/messaging/outbound.ts` (тест 5/5) |
| message_send в agent-loop (§14) + клиентская доставка | M6 | ✅ работает | `dispatch.ts`, `client/.../messaging.ts` |
| GramJS/vk-io реальная отправка (нужны сессии/токены) | M6 | 🟡 частично | адаптеры готовы; live — при кредах |
| Гарды заказа: spend cap / allowlist / порог + красная линия карты §0 | M7 | ✅ работает | `brain/orders/order-guard.ts` (тест 7/7) |
| Оркестрация заказа: confirm + idempotency + place (DI, без сети) | M7 | ✅ работает | `brain/orders/orders.ts` (тест 4/4) |
| order_place в agent-loop (§14) + клиентская доставка | M7 | ✅ работает | `dispatch.ts`, `client/.../browser.placeOrder` |
| Browser-автоматизация заказов (CDP-сборка корзины/чекаут) | M7 | 🟡 скелет | `client/.../browser.ts` stub (карту не вводит §0) |

---

## apps/server — задачи и нарративность (M8, §20)

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Модель задачи: Task, TaskState, cancel-флаг, предикаты | M8 | ✅ работает | `brain/tasks/task.ts` |
| TaskManager: реестр + жизненный цикл (create/cancel/pause/resume/finish/fail/sweep) | M8 | ✅ работает | `brain/tasks/manager.ts` (тест 8/8) |
| Классификатор управления: «стоп» (TTS) vs «отмени» (задача) §20 | M8 | ✅ работает | `brain/tasks/control.ts` (тест 10/10) |
| Нарратор: анонс / вехи / статус / финал / ошибка (детерм. RU) | M8 | ✅ работает | `brain/tasks/narrate.ts` (тест 16/16) |
| agent-loop: задача + стрим task.status + отмена ≤1 шага (§20) | M8 | ✅ работает | `brain/agent/index.ts` (тест 6/6) |
| router: голос/UI-управление задачей (стоп/пауза/продолжи/статус) | M8 | ✅ работает | `gateway/router-ws.ts` (тест 8/8) |
| Полная модель `tasks` в Postgres (persist + resume через verify) | M8 | 🟡 скелет | реестр in-process; БД-персист — TODO |
| Presence-доставка отчёта (ушёл → пуш, §20) | M8 | 🟡 скелет | `proactive/presence.ts` готов; провод в task-финал — TODO |
