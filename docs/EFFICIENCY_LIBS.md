# Экономия и эффективность Jarvis (УНИВЕРСАЛЬНО, на нижнюю границу железа)

> Источник: многоагентное исследование 2026-06-23 (32 агента) + переосмысление под универсальность 2026-06-23.
>
> 🔴 **ГЛАВНЫЙ ПРИНЦИП: проектируем на НИЖНЮЮ границу, не на потолок.** Боевой таргет продукта —
> **арендованный СЛАБЫЙ сервер (без GPU, мало CPU/RAM, мультитенант)** + клиенты на **произвольных,
> часто слабых** машинах. Мощное железо (RTX 5080/64GB) есть ТОЛЬКО у разработчика — на него
> закладываться НЕЛЬЗЯ. Локальный GPU = ОПЦИОНАЛЬНЫЙ тир через runtime capability-detection + облачный
> фолбэк, НИКОГДА не дефолт. (Предыдущая версия этого доку ошибочно строилась вокруг «задействовать
> простаивающую RTX 5080» — это анти-паттерн, см. [[feedback_universal]].)

## Где Jarvis жжёт деньги/время зря (3 корня — НЕ железо-зависимы)
1. **RAG сломан в корне.** `OPENAI_API_KEY` пуст → `openai-embeddings.ts` падает в `HashEmbeddingProvider` (случайные векторы, dim=256). episodic/skills/resolution вспоминают мусор → лишние переспросы и дорогие Opus-уточнения.
2. **all-Opus COGS-killer.** §7-эскалация мертва (все тиры=Opus), холодная перезапись ~25K-префикса на каждый тривиальный ход. Плоский $25-30 убыточен.
3. **Облачный STT теряет речь + лишний трафик.** Deepgram теряет ~½ речи на raw-PCM; клиент шлёт несжатый PCM.

## Архитектурные слои оптимизации (по универсальности)
- **A. Hardware-agnostic (софт/API)** — работает где угодно, в первую очередь на слабом сервере. ← ОСНОВНОЙ фокус.
- **B. Дешёвый облачный тир** — реальный рычаг COGS: дешёвая облачная модель для простых ходов + кеш. НЕ локальный GPU.
- **C. Лёгкий оффлоад на клиент** — только КРОШЕЧНЫЕ модели (WASM), которые тянет и слабая машина; разгружают сервер бесплатно.
- **D. Опциональный локальный тир** — для самохостеров/юзеров С GPU; через детект возможностей + облачный фолбэк. Никогда не допущение.

---

## A. Hardware-agnostic — работает на слабом сервере (ГЛАВНЫЕ quick wins)

| Приоритет | Что | Куда | Эффект |
|---|---|---|---|
| 🥇 | **Extended 1h prompt-cache TTL** — `cacheTtl:'1h'` **уже в коде** `anthropic.ts:82/91`, не активирован. Pure API, zero hardware | `integrations/anthropic.ts` (beta-заголовок) | Бьёт в НАЗВАННЫЙ корень убыточности: 5m-TTL истекает в паузах разговора >5мин → холодная перезапись 25K-префикса. До −90% на префиксе. Работает у ВСЕХ юзеров одинаково. |
| 🥈 | **Аудит размера 25K-префикса** + ужать персону/каталог, редкое дослать через `tool_load` | `persona/`, `anthropic.ts buildSystemBlocks` | Прямая атака на главный рычаг COGS. countTokens для замера. Zero-dep, универсально. |
| 🥉 | **Точный `countTokens`** (встроен в SDK) вместо хардкода `spend.check(...,0.01,2000)` | `brain/agent/index.ts`, `billing/index.ts` | Убирает системную ошибку SpendGuard. ⚠️ сетевой ~100-300мс — не на голосовой путь. |
| | **Native Structured Outputs** (`messages.parse`+`zodOutputFormat`) | `router/index.ts`, self-learn, `tasks/scope.ts` | Убирает ретраи на битый JSON (каждый на Opus = $). Апгрейд SDK, без новой зависимости. |
| | **pgvector halfvec HNSW + `iterative_scan`** (чистый DDL) | `memory/episodic.ts` + миграция | Full-scan O(N) → sub-ms; **меньше CPU/памяти на сервере** (важнее на слабом!). ~50% меньше памяти индекса. |
| | **Семантический кэш ответов** (GPTCache-стиль, server CPU + дешёвые эмбеддинги) | новый слой перед `anthropic.ts` | Повторяющиеся команды дворецкого → кэш вместо вызова Opus. Универсально, прямой COGS-cut. |
| | **`p-retry`@7 + `p-queue`@9** (MIT, Node 20) вместо самописного backoff | `packages/shared`, `anthropic.ts`, фон-пул | AbortSignal = отмена ретраев при «отмени»/stall; rate-limit против 429; приоритет голос>фон. Пинить v7. |
| | **`llmtrim`** (WASM, cache-prefix-safe) к НЕкешируемому хвосту | `memory/working.ts`, `dispatch.ts` | Рычаг 3-го порядка (хвост и так дёшев на cache-hit). Ниже 1h-TTL/аудита префикса. Цифры вендорские — мерить. |
| | **Helicone `packages/cost`** (Apache, standalone TS) вместо хардкод-тарифов | `obs/pricing.ts` | Cache-aware цены обновляются за тебя. Только библиотека, НЕ proxy-режим. |

## B. Дешёвый облачный тир — реальный рычаг COGS (НЕ локальный GPU)

| Что | Куда | Заметки |
|---|---|---|
| **Дешёвая облачная модель для простых ходов** — оживить мёртвую §7 РЕАЛЬНОЙ дешёвой моделью (Haiku / DeepSeek-flash-класс, не Opus, не локаль) | `providers.ts`, `router/index.ts`, эскалация `agent/index.ts` | **Главный универсальный COGS-рычаг.** Тянет ЛЮБОЙ сервер (вызов в облако). ⚠️ ROI: tier0 уже ловит много за $0 → мишень = простые-но-LLM ходы мимо tier0. Ср. юнит-эконому: DeepSeek ~142× дешевле Opus/ход. Гейтить по уверенности (закон честности). `anthropic.ts` уже принимает baseUrl. |
| **Чинить RAG дешёвыми облачными эмбеддингами** — `text-embedding-3-small` (~$0.02/1M, практически бесплатно) ИЛИ крошечный CPU-Model2Vec (near-zero CPU, без GPU) | `openai-embeddings.ts` | Универсальный фикс hash-RAG. Облако = ноль нагрузки на слабый сервер; Model2Vec = офлайн без GPU. e5-small на CPU допустим при низком объёме, но на мультитенанте облако/Model2Vec безопаснее по ресурсам. |
| **Дешёвый/лёгкий облачный STT/TTS** — выбрать провайдера/модель по цене; ИЛИ STT/TTS на КЛИЕНТЕ (платит юзерское железо) как опт-ин | `providers.ts createSttProvider/createTtsProvider` | По умолчанию облако (тянет слабый сервер). Локальное на клиенте — только опт-ин для способных машин (слой D). |

## C. Лёгкий оффлоад на клиент (крошечный WASM — тянет и слабая машина, разгружает сервер)

| Что | Куда | Эффект |
|---|---|---|
| **Аудио-транспорт Opus uplink** (WebCodecs нативно в Electron + `@discordjs/opus` decode) + `msgpackr` | `client/renderer/audio.ts`, `transport/`, `gateway/` | ~390→~16 kbit/s (~24×). $0. **Разгружает сеть/сервер** — важнее на слабом сервере и плохом канале юзера. `opus-recorder` НЕ брать (заброшен). |
| **Нейро-VAD Silero** (`@ricky0123/vad-web`, ISC, ~1МБ WASM) вместо RMS-порога | `client/main/vad/index.ts` | 87.7% TPR vs ~50% → меньше пустых финалов/дребезга. Чистый WASM в renderer — тянет слабый клиент, обходит native+кириллицу. |
| **Шумоподавление `RNNoise`** (~85КБ, WASM, 10-20мс) перед VAD/STT | `client/renderer/audio.ts` | Прямой корень «не слышит»/пустых финалов: чистит микрофон ДО STT. Крошечный, идёт ПЕРЕД дорогим AEC. |
| **Акустический wake-word `openWakeWord`** (Apache, ONNX, кастом «Джарвис») | `client wakeword/` | Лечит боль #4 в корне (текстовый MockWakeWord теряет зовы из-за STT-искажений) — акустика ДО STT. Лёгкая ONNX. |
| **Persistent Deepgram WS + `linear16`** (боль #1 CLAUDE.md) | `integrations/deepgram.ts` | Чинит «теряется ½ речи» + churn БЕЗ смены провайдера. Серверный фикс, универсален. |

## D. Опциональный локальный тир (capability-detected, opt-in, НЕ дефолт)
Для самохостеров/power-юзеров С GPU. **Только через runtime-детект (GPU/VRAM/CPU) + облачный фолбэк.** Если железа нет → автоматически слой B (облако). Так RTX 5080 разработчика становится тест-кейсом этого опционального пути, а не допущением для всех.
- Локальный LLM-тир: `node-llama-cpp` (native TS, CUDA prebuilt) — **обязательно включить prefix-cache движка** (`--prompt-cache`/slot-reuse), иначе холодный префилл 25K на GPU не быстрее Opus.
- Локальный STT: GigaAM v2 через `sherpa-onnx-node` (RU-WER 8.42% vs Whisper 16.21%). CTC = offline (без interim) → для barge-in нужен streaming (RNN-T/T-one).
- Локальный TTS: sherpa Piper-ru `dmitri` (CC0) + ударения (`RUAccent` имеет ONNX-вариант = без Python-сайдкара). ⚠️ риск TTFB на длинных фразах (VITS синтезирует целиком).
- ⚠️ Сквозное: кириллица в пути ломает native load → ASCII `~/.jarvis/models/`; **onnxruntime-node на Windows БЕЗ CUDA** (native-аддоны или DirectML); VRAM конкурирует с играми → фолбэк в облако при игре. distil-whisper/spec-decoding — промежуточный CPU-ускоритель если кто-то остаётся на Whisper.

## DO NOT ADOPT (проверено верификатором)
- **LiteLLM/RouteLLM/NotDiamond/Martian** как routing-мозг — роутеры не лучше zero-router; RouteLLM заброшен; cloud-роутеры = промпты в US-облако (152-ФЗ) + хоп. Реальный шаг = baseURL-сплит на дешёвую модель.
- **`@mastra/fastembed`** — supply-chain малварь на весь scope `@mastra` (17.06.2026). НЕ брать.
- **NVIDIA Parakeet/Canary для RU** (хуже), **Kokoro TTS** (нет RU), **Selective_Context** (заброшен+нет RU), **Piper оригинал** (архивирован/GPL).
- **TensorRT-LLM** (нет Node-биндинга), **Lunary** (репо удалён), **Picovoice/Krisp** (per-user лицензинг против убыточного тарифа), **`gpt-tokenizer`** для биллинга Claude (недосчитывает), **uWebSockets.js** (избыточен для одного юзера).

## Ключевые ссылки
- countTokens: https://platform.claude.com/docs/en/build-with-claude/token-counting · structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs · prompt caching (1h): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- эмбеддинги: https://platform.openai.com/docs/guides/embeddings · Model2Vec: https://github.com/MinishLab/model2vec · e5: https://huggingface.co/intfloat/multilingual-e5-small
- pgvector: https://github.com/pgvector/pgvector · quantization: https://jkatz05.com/post/postgres/pgvector-scalar-binary-quantization/
- Helicone cost: https://github.com/Helicone/helicone/blob/main/packages/cost/README.md · Langfuse: https://github.com/langfuse/langfuse · llmtrim: https://github.com/fkiene/llmtrim
- vad-web: https://github.com/ricky0123/vad · RNNoise WASM: https://github.com/jitsi/rnnoise-wasm · openWakeWord: https://github.com/dscripka/openWakeWord
- Opus encode: https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder/configure · @discordjs/opus: https://www.npmjs.com/package/@discordjs/opus · msgpackr: https://github.com/kriszyp/msgpackr
- опциональный локальный тир: node-llama-cpp https://github.com/withcatai/node-llama-cpp · GigaAM(sherpa) https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-ctc/nemo/russian.html
