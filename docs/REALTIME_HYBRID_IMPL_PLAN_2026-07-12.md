Grounding confirmed. Key facts verified against the actual repo: `voice/turn.ts` already has the endpointing seam (`TurnDetector`/`ISemanticTurnDetector`/`decideEndpoint`/`onProviderEndpoint`, текст-based); `voice/state.ts` is the pure reducer; `voice/latency.ts` (`LatencyTracker`) already exists; `voice/filler-cache.ts` already prefetches static «Секунду, сэр»; raw upstream PCM already reaches the server via `audio.frame {pcm, sampleRate, seq}`. Writing the plan.

---

# Гибрид Fast Talker + Slow Thinker для Джарвиса — инженерный план врезки

> Русский. Стек и файлы — реальные (проверены против репо). Всё, что требует живого микрофона/динамиков/инференса, отделено от юнит-верифицируемой логики. Неуверенные места помечены **⚠️**.

## 1. TL;DR

Целевая архитектура — **два независимых продюсера речи в один аудио-канал под единым `turnGen`-инвалидатором**: (1) *Talker* — дешёвый/локальный переключаемый быстрый тир, который на конце реплики СРАЗУ выдаёт контентно-пустую presence-фразу («секунду, гляну») или сам отвечает на простой разговорный ход; (2) *Thinker* — существующий каскад Sonnet→Opus с tool-use и §20-фоном, чей авторитетный ответ приезжает следом и **никогда не противоречит** filler-у (закон Non-Contradiction). Плюс акустический эндпоинтер (Smart Turn v3, 8 МБ ONNX) рядом с VAD, режущий «мёртвое время» паузы, и стрим-TTS Yandex v3 с per-phrase эмоцией.

**Наибольший скачок «живости» ПЕРВЫМ** даёт НЕ Talker и НЕ Smart Turn, а **перекрытие фаз TTS по клаузам** (инкремент, помеченный ниже как **C0/подготовка**) + **контентный Talker-filler поверх уже готового `filler-cache.ts`**: у Джарвиса латентность доминируется TTFT облачного Claude (2–13 с у Opus), и единственный способ убить воспринимаемую паузу — заговорить presence-фразой через ~250 мс, пока Thinker думает. Всё остальное (Smart Turn, спекуляция на partial) — второй порядок. Стартовать надо с **латентного харнеса** (он почти готов — `voice/latency.ts`), потому что оптимизация вслепую бессмысленна.

## 2. Целевой поток end-to-end

```
[КЛИЕНТ Electron]                                  [СЕРВЕР Node]
mic capture 48k ─► audio/index.ts.ingest
   │  wake (idle→listening)
   ├─► vad/index.ts.process → VadSignal (onset/hangover)
   │       │ speech_end кандидат
   │       ▼
   ├─ maybeBargeIn (barge-grace 250мс, порог rms)     audio.frame{pcm,sampleRate,seq}
   └─► transport.sendAudioFrame ──────────────────────►  gateway/router-ws
                                                          ├─► Deepgram WS (nova-3): interim + speech_final
                                                          ├─► ⓐ RingBuffer PCM@16k (НОВОЕ, per-session)
                                                          │      └─► SmartTurnEndpointer (сайдкар ONNX) → prob
                                                          ▼
                                          voice/turn.ts TurnDetector.onProviderEndpoint / onAcoustic
                                          (Deepgram speech_final ∧/∨ Smart Turn prob) → "endpoint"
                                                          ▼
                                          voice/state.ts reduce: listening→thinking (call_agent)
                                                          ▼
                                          brain/router: conversational | task  ◄── классификация $0
                              ┌───────────────────────────┼───────────────────────────┐
                     [Talker-alone]                [filler→Think]                 [filler→Act §20]
                     talker.answer()          talker.speakFiller() ║ runAgentLoop   earcon 160мс + filler
                              │                        │           ║  (Opus, фон)         │
                              ▼                        ▼           ▼                      ▼
                          TTS v3 stream          TTS v3 stream (producer=talker)   agent-loop tool-use
                              │                        │  turnGen,seq                     │
   ◄── speak.chunk{pcm16,sampleRate,producer,turnGen,seq} ──────────────────────── speakResult (итог)
   ▼
renderer/audio.ts PcmLivePlayer (carry-логика, чанк-гейт по turnGen)
   ▲  barge_in ─► cancelTts (инвалидирует ОБА продюсера по turnGen)
```

**Где живёт:** акустический эндпоинтер, RingBuffer, Talker, роутер-классификация, конвейер TTS-фраз, `turnGen`-инвалидатор — СЕРВЕР. Захват/VAD/barge-детект слой А, AEC, PcmLivePlayer — КЛИЕНТ.

**⚠️ Проверить первым делом:** идёт ли боевой mic-PCM на сервер через `audio.frame` (WS) или через LiveKit-канал — в `transport/index.ts` коммент: «Сам PCM в проде идёт по WebRTC (LiveKit); audio.frame по WS — dev-заглушка». Если прод на LiveKit — RingBuffer для Smart Turn надо ответвлять там, а не от `audio.frame`. Это развилка размещения инкремента A.

---

## 3. Инкременты по порядку рычага

### Инкремент 0 (обязательная подготовка) — латентный харнес «конец речи → первый звук»

**(а)** Замкнуть метрику mouth-to-ear: клиент шлёт ack «первый чанк реально сыгран» → сервер пишет разложение в `metrics.jsonl`. Без этого все прочие инкременты неизмеримы.
**(б)** `voice/latency.ts` — **уже есть** `LatencyTracker` с марками `turn_end/llm_first_token/tts_first_chunk/audio` и `firstAudioMs`. Доработка: новое протокол-сообщение `audio.played{turnGen,seq,ts}` (клиент `renderer/audio.ts` PcmLivePlayer знает момент старта воспроизведения) → `router-ws` зовёт `tracker.markAt("audio", ts)`. Расширить `metrics.recordRound` (Волна 1.8 `type:"round"` уже пишет пер-раунд).
**(в)** Переиспользуется целиком `LatencyTracker`, `metrics.jsonl`, earcon latency-марки (Волна 1.8).
**(г) Юнит:** подать синтетическую последовательность марок с фейковыми `now()` → проверить `report()` (уже покрыто `latency.test.ts`); добавить кейс на новый `audio.played`.
**(д) Живое:** снять реальный P50/P95 «speech_final → первый звук» на текущем контуре — это baseline, от него считаем выигрыш каждого следующего инкремента.
**(е)** Флагов не нужно (наблюдаемость всегда вкл).

---

### Инкремент A — акустический эндпоинтер Smart Turn v3 рядом с VAD

**(а)** Семантико-просодический детектор конца хода по СЫРОМУ звуку (Whisper-tiny энкодер + linear head, 8M, int8 ONNX ~8 МБ, инференс 12 мс CPU). Заменяет/дополняет текущее регекс-вето `HeuristicTurnDetector` настоящей моделью: режем тишину агрессивнее без роста ложных обрывов «на раздумье». Русский — в трейне v3 (не zero-shot).

**(б) Файлы/seam:**
- Новый `apps/server/src/voice/smart-turn.ts` — класс `SmartTurnEndpointer` (см. §4). Реализует **новый** интерфейс `IAcousticTurnDetector { predictComplete(pcm16le: Int16Array, sampleRate: number): Promise<number> }` (у текущего `ISemanticTurnDetector` вход — ТЕКСТ; Smart Turn — аудио, поэтому это отдельный seam, не подмена существующего).
- Врезка ровно в `voice/turn.ts`: добавить `TurnDetector.onAcoustic(prob): EndpointDecision` рядом с `onProviderEndpoint` — та же логика порога, но prob приходит от модели. Пороги — env, как уже сделано (`JARVIS_STT_ENDPOINT_PCT` и родня).
- Новый `apps/server/src/voice/smart-turn-sidecar-host.ts` — если всплывёт краш загрузки ONNX (см. риски), по образцу `voice/speaker/sidecar-host.ts` + `sidecar-protocol.ts` (готовый stdio newline-JSON + base64 PCM). **Первый заход — in-process** (data: e5 и Smart Turn — оба `onnxruntime-node`, конфликт был у sherpa-onnx, не у onnxruntime-node).
- RingBuffer PCM@16k per-session: `audio.frame` уже несёт `{pcm:b64, sampleRate}` в `router-ws` → ответвить копию Int16 в кольцевой буфер последних 8 с ДО/параллельно отправке в Deepgram. **Ресемпл к ровно 16 кГц обязателен** (см. подводный камень: WhisperFeatureExtractor хардкодит 16k, тихо ломается иначе). Ресемпл делать на клиенте при захвате (дешевле) либо на сервере перед экстрактором.
- Препроцессинг мел-спектрограммы — через `@huggingface/transformers` `WhisperFeatureExtractor.from_pretrained` (тянет тот же `onnxruntime-node`); НЕ писать STFT руками.
- Модель — `apps/server/models/smart-turn-v3.1.onnx` (int8). **⚠️ Форму входного тензора НЕ хардкодить** — интроспектировать `session.inputNames`/`input.dims` на загрузке (источники расходятся: (1,80,3000) vs ~800 фреймов при chunk_length=8).

**(в) Переиспользуется:** `onnxruntime-node` (e5), паттерн сайдкара (speaker-verifier) при нужде изоляции, `TurnDetector` stateful-обёртка, буфер VAD.

**(г) Юнит (мок ONNX):**
- `decideEndpoint`/новая ветка `onAcoustic(prob)` — пороги 0.5/0.6/fallback 3 с (по образцу `turn.test.ts`).
- Обрезка до последних 8 с + паддинг до 128000 сэмплов + ресемпл — чистые функции на фикстурах.
- **A/B-логгер расхождений** Smart Turn vs текущее `HeuristicTurnDetector` вето — сначала гоняем ПАРАЛЛЕЛЬНО, логируем, не свопаем.
- ONNX-сессию мокать фейком, возвращающим заданную `probability`.

**(д) Живое железо (чек-лист):**
- Реальная точность на русском (микрофон, живые реплики): полная фраза vs фраза с паузой посередине.
- Калибровка порога 0.5→0.6–0.7 против ложных cutoff.
- Замер «конец речи → earcon» на RTX 5080: **CPU-EP vs DirectML** (для 8M сети CPU часто выигрывает — копирование тензора в DML съедает выгоду).
- Оффлайн-смоук записанными WAV-фикстурами ДО живого микрофона.

**(е)** `JARVIS_SMART_TURN=0` (деф ВЫКЛ на первом этапе — A/B-режим), пороги `JARVIS_SMART_TURN_PCT` (деф 50), fallback `JARVIS_SMART_TURN_FALLBACK_MS` (деф 3000), `JARVIS_SMART_TURN_SIDECAR=0/1`.

---

### Инкремент B — Fast Talker (переключаемая модель) + мгновенный backchannel

**(а)** На конце реплики: (1) простой разговорный ход → Talker отвечает САМ, Thinker не зовётся; (2) глубокий разговорный → Talker даёт presence («хороший вопрос, секунду»), Thinker генерит настоящий ответ; (3) задача → earcon 160 мс + контентный filler («открываю Дота, секунду»), Thinker гонит agent-loop в §20-фоне. Filler **контентно-пуст**, `add_to_chat_ctx`-эквивалент = НЕ пишется в working-memory как ответ.

**(б) Файлы/seam:**
- Новый `apps/server/src/voice/talker.ts` — класс `Talker` (см. §4). Fast-модель ПЕРЕКЛЮЧАЕМА: дефолт — быстрый Sonnet-тир через существующий `anthropic.ts`; за env-флагом — локальная 3B (Ollama/llama.cpp в отдельном процессе, изоляция как speaker-сайдкар) или Haiku. **По правилу владельца Haiku дефолтом ВЫКЛ.**
- Классификация ветки — в `brain/router/index.ts`: расширить `RouteDecision` тремя исходами `talkerAnswers | fillerThenThink | fillerThenAct` поверх уже существующего `conversational` vs task-разделения (`looksLikeQuestion`/`looksHardReasoning`/`looksLikeAction`). **Детерминированно, $0, НЕ внутри Talker** (иначе лишний LLM-раунд до отклика).
- Врезка вызова — `brain/agent/index.ts` `handleUserText`, ПОСЛЕ роутер-классификации, параллельно/до `runAgentLoop`.
- **Апгрейд `voice/filler-cache.ts`:** статичные «Секунду, сэр» остаются фолбэком; при живом Talker — генерим контентный filler. `synthesizeToBuffer`/`wavFromPcm16`/`FillerCache.pick` переиспользуются как есть.
- **Cancel-safe scheduler:** отложенный ack-таймер (`JARVIS_TASK_ACK_MS`, уже cancel-safe — читает `task.cancel/state/spokeAny` в момент срабатывания) заменяется на filler-эмиттер той же конструкции. **Таймер ставить в pipeline, НЕ безусловным таймером в agent** (историческая грабля: agent-layer таймер стрелял ack после «отмени»). Если Thinker завершился раньше filler-таймера — filler НЕ произносить.
- Future-координация: после завершения filler добавить его текст в контекст Thinker (role=assistant), чтобы сильная модель ЗНАЛА что уже сказано и не повторялась (эталон LiveKit `fast-preresponse`).

**(в) Переиспользуется:** earcon 160 мс (`voice/earcon.ts`) как немедленный невербальный мост ПЕРЕД вербальным filler-ом (двухступенчатая presence, критично для облачного тира с TTFT ~700 мс); §20 background tasks; `Task.conversational`-флаг (filler/draft не всплывает в scope/«сделал?»); `filler-cache.ts`; PcmLivePlayer + v3-стрим; barge-in (`cancelTts`/grace 250 мс); «тихий финал» (filler не терминал); семантический кэш/tier0 = ветка Talker-alone.

**(г) Юнит (фейк-LLM, как `anthropic`-стабы):**
- Построение filler-промпта + `truncate(max_items=3)` контекста.
- Классификатор роутера `talkerAnswers/fillerThenThink/fillerThenAct` (детерминированный, как `looksLikeQuestion`).
- Future-координация «filler завершился → в контекст, чтобы Thinker не повторял».
- Cancel-safe scheduler (фейк-часы + cancel-флаг → после cancel filler НЕ эмитится).
- **Non-Contradiction денилист:** блок «утверждающих» filler-фраз («да/готово/это X/могу») — filler физически не может соврать исход.
- Sequencing filler→итог без двойной речи.

**(д) Живое:** реальный TTFT local-3B на RTX 5080 (Ollama, замерить — НЕ выдумывать, ⚠️); естественность filler+ответ Thinker встык (динамики); barge-in реально режет filler на mic; первый-чанк v3 под filler-нагрузкой; отсутствие GPU/onnxruntime-конфликта Talker↔e5/sherpa (local-Talker в отдельном Ollama-процессе изолирован).

**(е)** `JARVIS_TALKER=0` (деф ВЫКЛ до живой калибровки), `JARVIS_TALKER_MODEL=sonnet|local|haiku` (деф `sonnet`; `haiku` — осознанно вопреки дефолту владельца), `JARVIS_TALKER_LOCAL_URL` (Ollama endpoint), `JARVIS_TALKER_FILLER_MS` (переиспользовать/заменить `JARVIS_TASK_ACK_MS`).

**🔴 ГЛАВНАЯ ГРАБЛЯ:** filler ОБЯЗАН быть presence, НИКОГДА не утверждать исход — иначе класс «ложный успех», уже запрещённый `error-voice`-законом Джарвиса.

---

### Инкремент C — стрим-TTS Yandex v3 с per-phrase эмоцией + barge-in посреди стрима

**(а)** Каждая фраза LLM = отдельный `utteranceSynthesis` со своим массивом `hints` (role/speed/pitch_shift/volume). v3 **не поддерживает SSML** — эмоция задаётся НЕ инлайн-разметкой, а разбиением потока + per-request hints. Живость = варьирование role/pitch/speed между фразами, короткие фразы, микропаузы пунктуацией/вставной PCM-тишиной.

**(б) Файлы/seam:**
- `apps/server/src/integrations/yandex-tts-v3.ts` — **уже** REST-стрим utteranceSynthesis (первый чанк 143 мс). Доработка: принимать per-phrase `hints[]` вместо фиксированного голоса; keep-alive HTTP/2 Agent (одно тёплое соединение на сессию — иначе TLS+HTTP2 handshake 50–150 мс на фразу); `AbortController` на каждый фразовый запрос для barge-in.
- Новый чистый парсер фразовой разметки — вход `[emo=good spd=1.1 pitch=40] текст`, выход `{cleanText, hints[]}`. Мапит на существующие `brain/persona/emotion.ts` + `integrations/tts-emotion.ts` (каталог ролей уже есть). Директива — СВОЙ синтаксис (v3 без SSML), вырезается ДО синтеза; чистить текст от случайных `<break>`.
- `voice/pipeline.ts` — пофразный стриминг уже есть; добавить **префетч фразы N+1** во время проигрывания N + вставку PCM-тишины `silencePcm(ms)` между фразами.
- Протокол `TtsChunk/SpeakChunk` — уже несут `format:"pcm16"/sampleRate`; renderer `audio.ts` PcmLivePlayer уже играет сырой PCM с carry-логикой и barge-in — **не трогать**.
- **Свап голоса filipp→jane/alena:** filipp эмоцию good/evil не тянет (зафиксировано в карте). Осознанно, после живого прослушивания; дефолт v1/filipp остаётся фолбэком, v3-путь опт-ин (`TTS_PROVIDER=yandex3` уже есть).

**(в) Переиспользуется:** `yandex-tts-v3.ts` REST-стрим, PcmLivePlayer + carry, `emotion.ts`/`tts-emotion.ts`, пофразный конвейер pipeline, `wavFromPcm16`.

**(г) Юнит:**
- Парсер разметки → hints; сборка тела запроса (форма `hints`/`outputAudioSpec`).
- **ПОСТРОЧНЫЙ парсинг grpc-gateway стрима** (скормить канонические newline-JSON с base64 → извлечение PCM + буферизация частичных строк на границе чанков — частая ошибка).
- `silencePcm(ms)` генератор тишины.
- **Валидация пары voice+role по каталогу** (неподдержанная роль → ошибка ДО сети; иначе HTTP 400).
- Barge-in логика (`abort` → остановка + отмена префетча N+1).

**(д) Живое:** фактический TTFB под нагрузкой; аудибельность эмоции jane/alena (good/evil реально слышно?); естественность пауз/тишины на слух; ощущение barge-in посреди фразы (динамики+микрофон); квота/латентность реального endpoint; РФ-доступ (v3 из РФ штатно).

**(е)** `TTS_PROVIDER=yandex3` (уже есть, опт-ин), `JARVIS_TTS_VOICE=jane|alena|filipp`, `JARVIS_TTS_LOUDNESS=MAX_PEAK` (MAX_PEAK дешевле LUFS по TTFB старта), `JARVIS_TTS_PREFETCH=1`.

**Подводные камни v3:** (1) `pitch_shift` в Гц не полутонах — держать ±30–80; (2) LUFS задерживает первый чанк → MAX_PEAK; (3) SSML-теги уходят как символы/ошибка → чистить; (4) `unsafeMode:true` снимает лимит длины; (5) отдельный биллинг v3 → считать символы в SpendGuard отдельным расходом.

---

### Инкремент D (позже) — спекуляция на partial STT + машина состояний под barge-in + (опц.) AEC/WebRTC

**(а)** (D1) Спекулятивный draft-ход дешёвого тира на СТАБИЛЬНОМ interim ДО speech_final, commit/rollback на финале — экономия 200–400 мс. (D2) Машина состояний: `maybe_interrupted` + 3-исходный barge (STOP/RESUME/CONTINUE) вместо безусловного cancel. (D3) AEC своего TTS (WebRTC-loopback). (D4) WebRTC-транспорт — ТОЛЬКО если сервер уходит в интернет.

**(б) Файлы/seam:**
- **D1** — `brain/agent/index.ts` перед разветвлением тира: на interim (Deepgram даёт, confidence проброшен — Волна 1.6) + роутер `conversational` запускается draft Sonnet; commit/rollback на speech_final; abort через существующий stall-watchdog `anthropic.ts`. **ТОЛЬКО conversational-ветка** — tool-use с мутациями НЕ спекулировать (аренда ввода, необратимые эффекты). draft живёт рядом с §20 как «pending speculation», НЕ §20-задача (`Task.conversational`-флаг).
- **D2** — `voice/state.ts`: добавить `VoiceState "maybe_interrupted"` + событие `barge_candidate{durationMs, firstPartial, hasContentWord}` + ветку STOP/RESUME/CONTINUE с трекингом `playbackPositionMs`. `cancel_tts` не трогать (gen-инвалидатор рабочий) — только ОТЛОЖИТЬ его вызов до decision. Duration-guard 400 мс = 20 кадров×20 мс; backchannel-список RU («ага/угу/да/окей/понятно/ясно/мгм/хм»); content-word гейт переиспользует `memory/intent-polarity.ts`.
- **D2 клиент** — `apps/client/main/audio/index.ts` `maybeBargeIn` + `vad/index.ts`: слой А (отложить barge_in по duration-guard, переиспользовать/поднять grace 250→400 мс).
- **D3** — `apps/client/renderer/audio.ts`: WebRTC-loopback (pc1↔pc2 на localhost, TTS через `createMediaStreamDestination` как «remote» → браузерный AEC3 гасит). Для внешнего медиа (игра/видео) — desktopCapturer WASAPI-loopback как reference + WASM WebRTC-APM в AudioWorklet (тяжелее, отдельной задачей; **⚠️ точный API AudioWorklet-варианта не стандартизован — проверять зондом**).
- **D4** — оставить persistent-WS (`transport/index.ts`, resume/backoff готовы). WebRTC только после замера реального jitter канала; часто хватает Opus-кодека поверх WS + client-side jitter buffer. Транспорт <5% полной латентности — НЕ приоритет.

**(в) Переиспользуется:** gen-инвалидатор (расширить до `turnGen`+`producer` для двух продюсеров Talker/Thinker), Deepgram interim/speech_final, `intent-polarity.ts`, barge-grace, `state.test.ts`.

**(г) Юнит:** решение старта спекуляции (interim-стабильность+conversational); commit/rollback (interim vs final); весь `reduce()` с `maybe_interrupted` (`state.test.ts` готов); duration/content-word классификатор барджа (чистая функция); чанк-гейт `(turnGen,producer,seq)→play|drop`.

**(д) Живое:** voice-to-voice feel; AEC-настройка delay reference↔mic (микрофон+динамики); склейка Talker→Thinker на слух (нет щелчка/наложения); свой backchannel/TTS не распознаётся как команда после AEC; под-run/щелчки PcmLivePlayer.

**(е)** `JARVIS_SPECULATE=0`, `JARVIS_SPECULATE_STABLE_MS` (150–200), `JARVIS_ADAPTIVE_BARGE=0`, `JARVIS_AEC_LOOPBACK=0`.

---

## 4. Точные интерфейсы новых модулей (TS-скетчи)

```ts
// apps/server/src/voice/smart-turn.ts
export interface IAcousticTurnDetector {
  /** pcm16 mono LE @ sampleRate → prob(конец хода) 0..1. Ресемпл к 16k ВНУТРИ. */
  predictComplete(pcm16le: Int16Array, sampleRate: number): Promise<number>;
  readonly ready: boolean;
}
export interface SmartTurnParams {
  threshold: number;       // JARVIS_SMART_TURN_PCT/100, деф 0.5
  fallbackSilenceMs: number; // JARVIS_SMART_TURN_FALLBACK_MS, деф 3000
}
export class SmartTurnEndpointer implements IAcousticTurnDetector {
  constructor(modelPath: string, opts?: { device?: "cpu" | "dml"; sidecar?: boolean });
  // грузит @huggingface/transformers WhisperFeatureExtractor + ort.InferenceSession
  // ⚠️ форма input_features интроспектируется из session, НЕ хардкод
  predictComplete(pcm: Int16Array, sr: number): Promise<number>;
  get ready(): boolean;
}

// apps/server/src/voice/turn.ts — ДОБАВИТЬ в существующий TurnDetector:
// onAcoustic(prob: number): EndpointDecision  // порог как onProviderEndpoint, env-ручка

// apps/server/src/voice/ring-buffer.ts (per-session, восходящий PCM)
export class PcmRingBuffer {
  constructor(seconds: number, targetHz: 16000);
  push(pcm: Int16Array, sampleRate: number): void; // ресемпл к 16k внутри
  lastNSeconds(n: number): Int16Array;             // паддинг до n*16000
}

// apps/server/src/voice/talker.ts
export type TalkerModel = "sonnet" | "local" | "haiku";
export interface TalkerDeps {
  fastLlm: (msgs: Msg[], sys: string, ac: AbortSignal) => AsyncIterable<string>;
  tts: ITtsProvider; // v3 stream
}
export class Talker {
  constructor(deps: TalkerDeps, model: TalkerModel);
  /** presence-фраза (contentless) стримом в PcmLivePlayer; cancel-safe. */
  speakFiller(turnCtx: Msg[], userText: string, ac: AbortSignal): AsyncIterable<string>;
  /** прямой разговорный ответ Talker-alone (tier0/простой вопрос). */
  answer(turnCtx: Msg[], userText: string, ac: AbortSignal): AsyncIterable<string>;
}

// packages/protocol — расширить SpeakChunk двумя продюсерами:
export interface SpeakChunk {
  audio: ArrayBuffer; format?: "pcm16" | "mp3"; sampleRate?: number;
  turnGen: number;                    // единый инвалидатор хода
  producer: "talker" | "thinker";     // суб-канал
  seq: number;                        // порядок склейки
}

// per-phrase TTS разметка (чистая функция, apps/server/src/voice/tts-markup.ts)
export interface YandexHint { voice?: string; role?: string; speed?: number;
  volume?: number; pitchShift?: number; }
export function parsePhraseDirective(raw: string): { cleanText: string; hints: YandexHint[] };
export function validateVoiceRole(voice: string, role: string): boolean; // по каталогу, до сети
export function silencePcm(ms: number, sampleRate: number): Buffer; // нули int16
```

## 5. Риски и подводные камни интеграции

1. **Гонка Talker↔Thinker↔barge-in в одном аудио-канале.** Решение: единый монотонный `turnGen` на сессию + суб-канал `producer` в `SpeakChunk`; `cancelTts` инвалидирует по `turnGen` (оба продюсера); склейка Talker→Thinker по `(turnGen,seq)`. Дропать Thinker-чанк, пришедший после того как Talker-хвост финализировал ход. Юнит: чанк-гейт `(turnGen,producer,seq)→play|drop`. **Историческая грабля H11** (`state.ts`): `cancel_tts` безусловно бампает gen, а в listening уже открыт STT нового хода → лишний инкремент теряет follow-up. Тот же класс вернётся с двумя продюсерами — гейт по `turnGen`, а не по «есть ли что глушить».
2. **Non-Contradiction / ложный успех.** filler утверждает исход → ложь при провале Thinker. Денилист «утверждающих» фраз + промпт «не отвечай по сути, 5–10 слов». Это прямое пересечение с `error-voice`-законом.
3. **Эхо: свой filler/TTS → микрофон → ложная команда.** STT кормится только в `listening` (уже так). Для Talker-backchannel во время `thinking` нужен AEC (D3) ИЛИ игнор-окно ~400 мс после каждого своего чанка (расширить barge-grace 250 мс). Браузерный `echoCancellation` НЕ видит локальный WebAudio-TTS → WebRTC-loopback трюк.
4. **Кеш-префикс Claude при новом тире.** Talker — ОТДЕЛЬНАЯ модель/запрос, его filler НЕ идёт в контекст Thinker до завершения → кеш Thinker цел. Но переключение Talker-модели (sonnet↔local) не должно трогать Thinker-набор tools/system (иначе разовый кеш-промах — как rolling-breakpoint). Держать Talker полностью в стороне от `buildSystemBlocks`.
5. **Аренда ввода.** Спекуляция и Talker — СТРОГО conversational-ветка (нет аренды, нет мутаций → откат бесплатен). Task/tool-use ветка идёт как сейчас, последовательно, verify-loop цел. Draft НЕ §20-задача.
6. **Русский в endpoint-модели.** Smart Turn v3 — русский в трейне, но **⚠️ РУ-качество подтвердить живьём** перед свопом с `HeuristicTurnDetector`; держать A/B параллельно, свопать по логу расхождений.
7. **16 кГц хардкод Smart Turn.** Не-16k без ресемпла → тихая деградация (переворот классификации ~30%, дробление). Гарантировать 16k моно float32 [-1,1] на входе экстрактора; `audio.frame` несёт `sampleRate` — ресемплить явно.
8. **onnxruntime краш на Windows.** Data: e5+Smart Turn (оба `onnxruntime-node`) совместимы; конфликт был sherpa-onnx vs onnxruntime. Если всё же краш — вынести в сайдкар по образцу `voice/speaker/sidecar-host.ts`. Local-Talker (Ollama) — отдельный процесс, GPU/onnxruntime не пересекает.
9. **grpc-gateway построчный парсинг v3.** Не один JSON — буферизовать частичные строки на границе чанков (уже есть carry в PcmLivePlayer для байт; строки — отдельно).
10. **⚠️ Боевой аудио-путь.** Если прод на LiveKit, а не `audio.frame` WS — RingBuffer Smart Turn ответвлять там. Проверить первым.

## 6. Чек-лист живой калибровки для владельца (микрофоном, после каждого инкремента)

- **После 0:** снять baseline P50/P95 «конец речи → первый звук» (лог `metrics.jsonl`), запомнить цифру.
- **После A:** сказать длинную фразу С ПАУЗОЙ посередине («открой… эм… дискорд») — Джарвис НЕ должен обрывать на паузе; короткую команду — должен реагировать быстрее baseline. Покрутить `JARVIS_SMART_TURN_PCT` 50→60→70. Сверить лог A/B: где Smart Turn расходится с регекс-вето.
- **После B:** задать простой вопрос (Talker-alone отвечает сам, Opus молчит); дать задачу («запусти поиск в доте») — earcon 160 мс мгновенно, затем контентный filler «открываю…», затем итог; перебить filler голосом на середине — filler режется, не договаривает; сказать «отмени» сразу после команды — filler НЕ звучит после отмены.
- **После C:** послушать эмоцию jane/alena good vs evil vs neutral — реально ли слышна разница; естественны ли микропаузы; barge-in посреди фразы обрывает чисто без хвоста.
- **После D:** разговорный вопрос — ответ приходит заметно раньше (спекуляция); сказать «угу» во время речи Джарвиса — НЕ прерывает (backchannel), сказать содержательное — прерывает (STOP); при играющем видео/музыке свой TTS не распознаётся как команда (AEC).

## 7. Рекомендация — что строить ПЕРВЫМ

**Порядок по (рычаг × верифицируемость): 0 → C(перекрытие фаз)+B(Talker) → A → D.**

Строить **первым — Инкремент 0 (латентный харнес)**: 0 риска, полностью юнит-верифицируем, база `LatencyTracker` уже написана — нужен лишь замыкающий `audio.played` ack от клиента. Без него любой следующий выигрыш неизмерим, а оптимизация вслепую.

**Сразу за ним — связка «перекрытие фаз TTS по клаузам + контентный Talker-filler поверх `filler-cache.ts`»** (части C и B). Это даёт НАИБОЛЬШИЙ скачок воспринимаемой живости, потому что доминирующий сегмент латентности Джарвиса — TTFT облачного Claude (2–13 с Opus), и единственный способ его спрятать — заговорить presence-фразой через ~250 мс. Фундамент уже стоит: пофразный стрим pipeline, v3 PCM (143 мс), PcmLivePlayer, `filler-cache.ts` (статичный filler → апгрейд до контентного), earcon 160 мс, `Task.conversational`, cancel-safe ack-таймер. Логика (Non-Contradiction денилист, cancel-safe scheduler, sequencing, парсер hints, построчный парсинг стрима) — вся мокабельна; живьём проверяется только «звучит ли естественно».

**Smart Turn (A) — третьим:** рычаг реальный (режет «мёртвое время» эндпоинта), но требует РУ-калибровки живьём и упирается в ⚠️ (форма тензора, ресемпл, боевой аудио-путь, ONNX на Windows) — рискованнее и медленнее в верификации, чем B/C, при меньшем скачке (эндпоинтинг у Джарвиса уже 350–400 мс, приемлем). **D — последним**, поштучно, спекуляция > adaptive-barge > AEC > WebRTC (последний — только если сервер уедет в интернет).

---

## Источники

- Pipecat Smart Turn v3: https://huggingface.co/pipecat-ai/smart-turn-v3 · https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/ · https://github.com/pipecat-ai/smart-turn/blob/main/inference.py · https://github.com/pipecat-ai/pipecat/issues/3844
- LiveKit fast-preresponse / turn-detection / adaptive interruption: https://github.com/livekit/agents/blob/main/examples/voice_agents/fast-preresponse.py · https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection · https://livekit.com/blog/adaptive-interruption-handling · https://livekit.com/blog/understand-and-improve-agent-latency
- ConvFill «Thinking While Speaking»: https://arxiv.org/html/2511.07397v3
- Параллельные SLM+LLM: https://webrtc.ventures/2025/06/reducing-voice-agent-latency-with-parallel-slms-and-llms/ · https://www.ml6.eu/en/blog/stop-building-voice-wrappers-the-architecture-behind-reliable-voice-agents
- Yandex SpeechKit v3 (proto/REST/голоса/шаблоны/SSML-только-v1): https://github.com/yandex-cloud/cloudapi/blob/master/yandex/cloud/ai/tts/v3/tts.proto · https://yandex.cloud/en/docs/speechkit/tts/api/tts-v3-rest · https://aistudio.yandex.ru/docs/en/speechkit/tts/voices.html · https://github.com/yandex-cloud/docs/blob/master/en/speechkit/tts/markup/ssml.md
- transformers.js WhisperFeatureExtractor: https://deepwiki.com/huggingface/transformers.js/6.2-audio-processing
- Латентный бюджет / транспорт: https://www.channel.tel/blog/voice-ai-pipeline-stt-tts-latency-budget · https://livekit.com/blog/why-webrtc-beats-websockets-for-voice-ai-agents
- AEC: https://switchboard.audio/hub/how-webrtc-aec3-works/ · https://github.com/nguyenvulebinh/browser-aec
- Haiku 4.5 TTFT: https://artificialanalysis.ai/models/claude-4-5-haiku/providers

*Файлы Джарвиса, проверенные при составлении плана: `apps/server/src/voice/{turn,state,latency,filler-cache,earcon,pipeline}.ts`, `apps/server/src/voice/speaker/sidecar-host.ts`, `apps/server/src/integrations/yandex-tts-v3.ts`, `apps/client/main/{audio,vad,transport}/index.ts`, `apps/client/renderer/audio.ts`.*