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
| router / classifyTier (скелет §7) | M0 | 🟡 скелет | `apps/server/src/brain/router/index.ts` |
| agent M0 (dev.text → app.launch round-trip) | M0 | ✅ работает | `apps/server/src/brain/` |
| persona (сборка system-промпта) | M0 | ✅ работает | `apps/server/src/brain/persona/index.ts` |
| persona.md (характер Джарвиса, §11) | M0 | ✅ работает | `apps/server/src/brain/persona/persona.md` |
| Вербализатор §21 (детерминированный RU-постпроцессор) | M0 | ✅ работает | `apps/server/src/brain/persona/` |
| Роутинг тиров Haiku/Sonnet/Fable (полный, §7) | M2 | 🟡 скелет | TODO(M2) |
| Агент Sonnet/Fable (tool-calls, многошаговый) | M2 | 🟡 скелет | TODO(M2) |
| web.search / web.fetch (server-side §12) | M2 | ⬜ не начато | TODO(M2) |

---

## apps/server — memory

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Working memory (кольцевой буфер сессии) | M0 | ✅ работает | `apps/server/src/` |
| Episodic memory (pgvector + retrieval) | M2 | 🟡 скелет | TODO(M2) |
| Skills CRUD (SKILL.md per-user) | M4 | 🟡 скелет | TODO(M4) |
| Ночная консолидация | M4 | ⬜ не начато | TODO(M4) |

---

## apps/server — proactive / scheduler / billing

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| scheduler.computeTriggerTs (формула §9) | M0 | ✅ работает | `apps/server/src/` |
| Billing limits / spend cap / kill-switch (§14) | M0 | ✅ работает | `apps/server/src/` |
| Trigg'еры / salience / proactive пайплайн | M5 | ⬜ не начато | TODO(M5) |
| ETA (Yandex/OSRM) | M5 | ⬜ не начато | TODO(M5) |
| Интеграция ICalendarProvider | M5 | ⬜ не начато | TODO(M5) |

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
| actuators/code-runner.ts (изолированный раннер стаб) | M3 | 🟡 скелет | `apps/client/main/actuators/code-runner.ts` |
| actuators/ground.ts (IPC к sidecar-win стаб) | M3 | 🟡 скелет | `apps/client/main/actuators/ground.ts` |
| actuators/input.ts (SendInput через sidecar стаб) | M3 | 🟡 скелет | `apps/client/main/actuators/input.ts` |
| tier0/ (детерминированные команды, $0) | M0 | ✅ работает | `apps/client/main/tier0/index.ts` |
| transport/ (WebSocket к серверу) | M0 | ✅ работает | `apps/client/main/transport/` |
| wakeword/ (детектор «Джарвис») | M1 | ✅ работает | mock + push-to-talk; onnx openWakeWord опц. (RU-валидация §18) |
| vad/ (Silero VAD) | M1 | ✅ работает | энергетический VAD (RMS+hangover); Silero/onnx опц. |
| audio/ (координация: PCM → wakeword/vad, гейтинг стрима) | M1 | ✅ работает | privacy-гейт + barge-in, тест 5/5 |
| sensors/ (screenshot, active-window) | M3 | 🟡 скелет | `apps/client/main/sensors/` |
| skill-runner/ (детерминированный интерпретатор шагов) | M4 | 🟡 скелет | `apps/client/main/skill-runner/` |

---

## apps/client — renderer

| Компонент | Milestone | Статус | Файлы |
|---|---|---|---|
| Текстовый ввод (dev.text) | M0 | ✅ работает | `apps/client/renderer/` |
| Confirm-модалка (user.confirm.request) | M0 | ✅ работает | `apps/client/renderer/` |
| Аудио-захват/воспроизведение (getUserMedia + AudioWorklet + WebAudio) | M1 | ✅ работает | `renderer/audio.ts`, `audio-worklet.js` |
| Орб (idle/listening/thinking/speaking) | M1 | ✅ работает | + push-to-talk по клику |
| DisplayCard (ui.display карточки §21) | M8 | 🟡 скелет | TODO(M8) |
| Task progress (task.status стрим) | M8 | ⬜ не начато | TODO(M8) |

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
| GramJS (Telegram userbot) | M6 | ⬜ не начато | TODO(M6) |
| vk-io (VK userbot) | M6 | ⬜ не начато | TODO(M6) |
| Cadence guard / idempotency | M6 | ⬜ не начато | TODO(M6) |
| Browser-автоматизация заказов | M7 | ⬜ не начато | TODO(M7) |
