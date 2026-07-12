# Джарвис → «как Grok Voice»: отчёт и план перехода к realtime-живому голосу

## 1. TL;DR

**Можно ли сделать «как Grok»?** Полный паритет с Grok Voice на текущем стеке — **нет**. «Живость» Grok неотделима от нативной **speech-to-speech (S2S) модели** `grok-voice-think-fast-1.0`: аудио→аудио одной моделью, без текстового промежутка, full-duplex, эмоция генерируется в самих аудио-токенах, TTFA ~0.78с (медиана time-to-first-audio 460мс, 285мс в стриминг-режиме). Claude — **текстовый reasoner без аудио-I/O**, поэтому Джарвис структурно обречён быть каскадом, пока мозг = Claude. Это **архитектурная, а не тюнинговая** разница.

**Где стена (три стены):**
1. **Мозг Claude ≠ S2S.** Sub-800мс на *содержательном* (reasoning+tool) ответе и просодия-в-просодию (эмоция входа → эмоция ответа) каскадом недостижимы. Ход Claude 2–13с — на 1–2 порядка медленнее 285–700мс Grok.
2. **РФ/санкции.** OpenAI Realtime, Gemini Live, Grok Voice, ElevenLabs — все под EU Art 5n (запрет hosted-AI-inference в РФ); OpenAI явно отрезал РФ с ~9 июля 2025. Для приватного one-user ассистента это дисквалифицирует их как боевой стек.
3. **Локальный S2S по-русски на 16GB.** Единственная открытая модель с sub-300мс full-duplex (Moshi) — **English-only**; единственная открытая с нативным русским голосом (Qwen3-Omni-30B) **не влезает в 16GB** даже в Int4 (нужно 24GB+).

**Ключевой архитектурный выбор:** не гнаться за заменой мозга на S2S, а строить **гибрид «Fast Talker + Slow Thinker»** (паттерн grok-voice-think-fast / Step-Audio R1.1 Dual-Brain / Qwen Thinker-Talker): быстрый разговорный слой ведёт живой диалог мгновенно, Claude-каскад досчитывает сложное и действия в фоне.

**За сколько усилий?** Ощущение «резко живее» достижимо за **1 спринт** (эндпоинтинг-модель + быстрый тир + осознанные филлеры + эмоц. голос) без смены мозга. Полный full-duplex «как Grok» — большое отдельное решение (локальный S2S-фронт), упирающееся в железо (нужен апгрейд 24GB+).

---

## 2. Почему Джарвис сейчас НЕ живой — разбор латентного бюджета

Узкое место — **не конвейер, а сам ход Claude**. Пофразный TTS-стриминг у Джарвиса уже есть; TTS ~0.4с — не проблема. Секунды теряются так:

| Стадия | Текущий бюджет | Комментарий |
|---|---|---|
| Ожидание конца реплики (endpointing) | ~350–400мс (Deepgram `speech_final`) + клиентский путь 520+150мс как фолбэк | Это класс «жди тишину» (silence-timeout VAD). LiveKit: фикс-порог тишины «добавляет почти целую секунду к каждому ответу до старта пайплайна». |
| STT Deepgram | <5мс при стриминге | Не узкое место. |
| **Генерация Claude (мозг)** | **2–13с** | **ГЛАВНАЯ СТЕНА.** Это полноценный reasoning, а не lite-S2S. TTFT первого хода 0.9–1.4с даже у быстрых, у Opus с тяжёлым кеш-промптом — секунды. |
| TTS Yandex (первый чанк) | ~0.4с (v3 PCM-стрим первый чанк 143мс) | Не узкое место; но filipp эмоцию не умеет (только strict). |

**Итог:** порог естественности разговора ~200мс (человеческий baseline реакции), «живо» = sub-800мс, >2с = юзер думает, что сломалось. Джарвис на содержательном ходе живёт в зоне 2–13с. Причём глубокое рассуждение в realtime — это не «медленный ход», а «сброшенный звонок» (reasoning-TTFT на сложном 8–200с+). Барьер держит **машина состояний** `idle/listening/thinking/speaking`: STT кормится только в `listening`, во время `speaking` Джарвис себя не транскрибирует → истинного full-duplex и backchannel («угу») нет.

---

## 3. Что делает Grok / OpenAI Realtime / Gemini Live «живыми»

**Корень — S2S, не качество голоса.** Единая модель схлопывает ASR+LLM+TTS в один цикл: сигнал входит, сигнал выходит, транскрипт вообще не эмитится. Исчезают три хендоффа → исчезают «паузы на стыках» («temporal uncanny valley»). Сохраняется паралингвистика: интонация, темп, паузы, смех.

**Конкретные механизмы и цифры:**
- **Grok Voice** — `grok-voice-think-fast-1.0` на движке Grok 4.3. Весь стек in-house: свой VAD (**DASP**), свой аудио-токенизатор (waveform→токены минуя транскрипцию), свой full-duplex движок. TTFA ~0.78с (при высокой reasoning-нагрузке 1.25с). Транспорт — WebSocket `wss://api.x.ai/v1/realtime`, PCM16 24kHz base64, server-side VAD по умолчанию, barge-in встроен («не останавливается и не рестартует — адаптируется»). Тулколы прямо в realtime-цикле, async с `cancel_on_interruption`. τ-voice Bench: Grok ~67–74% против Gemini Live ~21.9% и GPT Realtime ~21.1%.
- **OpenAI gpt-realtime / 2.1** — WebRTC/WS/SIP, glass-to-glass ~500–1200мс первый ход, 300–600мс последующие; v2.1 (июль 2026) добавила reasoning и срезала p95 на 25%. `semantic_vad` с параметром **eagerness** (low/medium/high) — адаптивный таймаут вместо фикс-порога тишины.
- **Gemini Live** — native-audio, заявлено 320–800мс, но независимый бенч апр-2026 намерил TTFA 2.98с у 3.1 Flash Live (большой разброс).
- **Turn-taking / full-duplex (Moshi-класс)** — двухпотоковая структура моделирует аудио системы и пользователя **параллельно**, «никогда не отдаёт микрофон». Overlap — не край, а >40% ходов (Full-Duplex-Bench, SALMONN-omni, OmniFlatten). **Backchannel** («угу», «понял», не забирая ход) возможен только когда модель непрерывно слушает и генерирует одновременно — в каскаде это лишь хак по таймеру.
- **Эмоция** генерируется нативно в аудио-токенах (тон/темп/ударение/ритм/энергия), а не навешивается TTS-тегами. Двухслойный дизайн: базовый ГОЛОС (Ara/Eve/Leo…) отдельно от ПОВЕДЕНИЯ (Assistant/Therapist/Storyteller…).
- **Dual-Brain** (рецепт «живой И умный»): Step-Audio R1.1 (StepFun, янв 2026, 97% Big Bench Audio) разделяет рассуждение и артикуляцию — сложное reasoning без потери плавной речи; быстрый фронт держит поток, тяжёлое идёт параллельно.

**Ключевой инсайт:** «разница не в том, что Grok звучит лучше — в том, что тишина между ходами перестаёт быть неловкой».

---

## 4. Варианты для Джарвиса — честное сравнение

| Критерий | **(A) Облачный realtime API** (OpenAI/Gemini/Grok/ElevenLabs) | **(B) Улучшенный каскад** (streaming + endpointing-модель + быстрый тир + TTS-overlap) | **(C) Локальный S2S** (Moshi / Qwen-Omni на RTX 5080) |
|---|---|---|---|
| Латентность | 0.78–2.98с TTFA (Grok 0.78, OpenAI 0.82, Gemini 2.98) | ~0.6–1.5с на болтовне (быстрый тир), 2–13с на reasoning остаётся | Moshi ~200мс, Qwen3-Omni e2e до 234мс |
| «Живость» | **Максимум** (нативный full-duplex, просодия-в-просодию) | Средняя: эффект близости филлерами/backchannel-хаком; истинного дуплекса нет | Высокая локально (full-duplex), но качество RU-эмоции под вопросом |
| Приватность / РФ | **Стена:** данные в облако США; OpenAI отрезал РФ, EU Art 5n; VPN+иностр.карта = серо, не production | **По-российски приватно** (Claude+Yandex — текущий контур) / полностью приватно если локальный TTS | **Максимум** ($0/мин, аудио не покидает ПК) |
| Русский | Grok RU в слепых оценках предпочтён OpenAI; Yandex-шелл RU нативно | Нативный (Deepgram RU + Yandex RU) | Moshi — нет; Qwen3-Omni — есть в списке speech-out; качество RU тестировать |
| Tool-use / мозг Claude | OpenAI/Gemini/Grok — мозг **зашит**, Claude не подключить. Только **ElevenLabs custom-LLM** сохраняет Claude, но возвращает его 2–13с | **Claude-мозг + 100+ инструментов Джарвиса целы** | Локальная 7B много слабее Claude → только фронт, не мозг |
| Цена | Grok ~$0.05–0.06/мин; OpenAI $0.04–0.24/мин (длинная сессия раздувается: перезаряд токенов → $1.50+/мин на 30-мин); Gemini ~$0.023/мин | Дельта к текущему: Haiku-тир дёшев, filipp→jane бесплатно | $0/мин (электричество) |
| Усилия | Средние (интеграция шелла), но упор в РФ-доступ | **Низкие–средние** (эволюция текущего) | Высокие (сайдкар, изоляция onnxruntime, апгрейд GPU) |
| Вердикт | Дисквалифицирован РФ-доступом и/или потерей Claude | **Реалистичный основной путь** | Приватный fallback / исследование; упирается в 16GB |

**Ключевое:** вариант (A) без ElevenLabs выбрасывает Claude-мозг и всю tool-экосистему; с ElevenLabs — сохраняет Claude, но realtime-шелл не лечит его think-time. Вариант (C) на **одном RTX 5080 (16GB)** боевого realtime-S2S не тянет: даже 4090/24GB держит Moshi «без запаса»; Qwen3-Omni-30B в Int4 ~18–22GB > 16GB. Запасной локальный — **Qwen2.5-Omni-7B (Int4)** влезает, но RU speech-out не заявлен так явно.

---

## 5. Рекомендуемая ГИБРИД-архитектура: «Fast Talker + Slow Thinker»

Расширение существующего тир-каскада Джарвиса, **переставленное**: не «эскалируй, когда застрял», а **«дешёвый ведёт диалог СРАЗУ, дорогой досчитывает параллельно»**.

```
                    ┌─────────────────────────────────────────────┐
   голос юзера ─────▶│  Клиент (Electron): захват + VAD + AEC       │
                    │  Smart Turn v3 (endpointing-модель, локально)│
                    └───────────────┬─────────────────────────────┘
                                    │ partial + final STT
                    ┌───────────────▼──────────────┐
                    │  FAST TALKER (разговорный слой)│  <300–600мс
                    │  • backchannel/ack/clarify     │──▶ мгновенный отклик,
                    │  • smalltalk, подтверждения    │    держит присутствие
                    │  • Haiku 4.5 ИЛИ локальная S2S │
                    └───────────────┬────────────────┘
                                    │ сложное / действие
                    ┌───────────────▼────────────────┐
                    │  SLOW THINKER (мозг, в ФОНЕ)     │  2–13с, но НЕ в тишине
                    │  • Claude Sonnet→Opus каскад     │
                    │  • 100+ инструментов, actuators  │──▶ дополняет/поправляет
                    │  • навыки, verify-loop           │    речь Talker'а на лету
                    └──────────────────────────────────┘
```

**Как совмещаются ум и скорость.** Talker отвечает мгновенно из дешёвого тира/кеша, пока Thinker (Opus) префетчит контекст и готовит сложный ответ (паттерн «Thinking While Speaking», LTS-VoiceAgent). Джарвис **уже** различает вопрос vs действие (`looksLikeQuestion`/`looksLikeAction`) — достаточно повесить быстрый тир на разговорную ветку.

**Где живёт realtime-слой.** На **клиенте** (Electron, RTX 5080) — там, где аудио и минимальная сетевая задержка:
- Эндпоинтинг-модель (Smart Turn v3) — локально, рядом с текущим VAD.
- Fast Talker: сначала — Claude **Haiku 4.5** (тот же SDK/кеш/биллинг, ~100–600мс), позже опционально — локальная малая S2S в сайдкаре для истинного full-duplex.

**Барж-ин + tool-use + полнодуплекс.** Barge-in у Джарвиса уже есть (rms-порог 350, cancelTts, playback.stop). Для семантического дуплекса детектор надо держать активным **во время speaking** — но это упирается в **акустическую стену** (эхо своего TTS + внешнее медиа), решается **loopback-AEC** (WASAPI/desktopCapturer reference → WebRTC APM), который сейчас стаб. Tool-use остаётся у Thinker'а (Claude): Talker не действует, а лишь ведёт разговор и делегирует; действия/actuators идут через существующий dispatch под арендой ввода — как сейчас.

---

## 6. ПЛАН реализации по этапам (что даёт наибольший скачок первым)

### Этап 0 — MVP «резко живее» (наибольшая отдача, малая цена) — 1 спринт

Применимо и к дейли-стендапу, и к обычному разговору.

1. **Эндпоинтинг-модель Pipecat Smart Turn v3** (наибольший единичный выигрыш по turn-taking). Открытая (Apache), локальная, 8 МБ, 12мс CPU-инференс, **поддерживает русский** (точность RU 93.67%). Ставится клиентом рядом с текущим VAD: Silero/EnergyVad ловит границу тишины → Smart Turn v3 по сырому waveform решает «конец хода или пауза». ONNX-инфра в проекте уже есть (e5/sherpa). Убирает главный walkie-talkie-лаг (~секунда фикс-тишины), не трогая мозг. Порог false-cutoff тюнить: при бюджете 300мс — 9.9%, при 600мс — 4.5%.
2. **Быстрый тир на разговорную ветку.** Маршрутизировать `conversational`-ходы на **Haiku 4.5** (Talker для коротких реплик/подтверждений/smalltalk), Opus — только действия/сложное. Джарвис уже различает вопрос vs действие — повесить быстрый тир на ветку. (Haiku «забракована» как исполнитель — использовать ТОЛЬКО как голос-фронт.)
3. **Осознанные филлеры/backchannel.** Вернуть избирательно (Джарвис ранее выключил по концепции) — короткий «Хм, секунду, сэр» / earcon на ходах >800мс, **cancel-safe в pipeline** (не безусловный ack в agent-слое — старый баг стрелял ack после «отмени»). Earcon-ack 160мс уже есть — дотянуть до умного backchannel.
4. **Эмоц. голос без смены архитектуры.** Перейти на **Yandex SpeechKit v3 streaming** (PCM уже в коде, опт-ин, первый чанк 143мс) + голос **с ролями (jane/alena/alena, НЕ filipp)** — роли neutral/good/evil/friendly. Claude пофразно эмитит разметку эмоции/темпа (расширить `emotion.ts` до per-phrase) → TTS как управляемый инструмент, каскад приближается к S2S.

### Этап 1 — спекуляция и транспорт — 2–3 спринта

5. **Спекулятивный ход на частичном STT.** У Джарвиса эндпоинтинг ~350–400мс и спекулятивный эндпоинт уже частично есть — наложить предиктивную генерацию дешёвым тиром до финала: hit → мгновенный ответ, miss → откат («thinking while listening», Dynamic Semantic Trigger).
6. **Адаптивный таймаут (eagerness).** Формализовать порогами существующее «семантическое вето висящих союзов»: уверенный конец → 0мс ожидания, трейлинг «эээ/и…» → длиннее.
7. **WS → WebRTC с ICE Trickle** (клиент↔сервер) — медиапоток стартует до полного хендшейка (экономия сотен мс), лучше джиттер-контроль для дуплекса.

### Этап 2 — истинный full-duplex (амбициозно, отдельное решение)

8. **loopback-AEC** (WASAPI/desktopCapturer reference → WebRTC APM в ворклете) — гасит свой TTS И внешнее медиа → детектор можно держать активным во время speaking = семантический barge-in + backchannel по смыслу.
9. **Локальный S2S-фронт в сайдкаре** (Qwen2.5-Omni-7B Int4 влезает в 16GB; изоляция от onnxruntime e5/sherpa в отдельном процессе — как speaker-сайдкар). Держит smalltalk/turn-taking/эмоц. подтверждения локально и приватно; тяжёлое делегирует Claude. **Русский Qwen-Omni тестировать живьём.** Полный Qwen3-Omni-30B — после апгрейда GPU до 24GB+ (5090).

**Что применить к дейли-стендапу:** болтовня/подтверждения/«принял» — Haiku Talker sub-second; разбор задач/выгрузка из трекера/анализ — Opus фоном. Стендап 15 мин/день на облачном S2S ≈ $22/мес (референс Grok), но с гибридом на Claude+Yandex — в текущем контуре.

**Что даёт скачок ПЕРВЫМ:** пункт 1 (Smart Turn v3) + пункт 2 (Haiku-Talker) + пункт 3 (филлеры) — вместе убирают ощущение «рации» и молчания на 2–13с, не меняя мозг и оставаясь в РФ-приватном контуре.

---

## 7. Риски и пределы

- **Латентный floor Claude неустраним.** Sub-800мс на *содержательном* reasoning-ответе каскадом недостижим; глубокое рассуждение в голосе всегда будет ощущаться медленнее Grok. Гибрид маскирует это Talker'ом, но не отменяет.
- **Русский в локальном S2S.** Moshi — English-only (мультиязычный чекпоинт таргет Q1-2026, RU не подтверждён). Qwen3-Omni RU в списке speech-out, но качество RU-просодии/эмоции **надо проверять живьём**. Полностью открытой, проверенно-русской, лёгкой-на-16GB S2S уровня Moshi на середину 2026 **нет**.
- **Качество рассуждений быстрых моделей.** Haiku слабее на русском рассуждении — годна ТОЛЬКО как фронт диалога, не мозг. Локальная 7B много слабее Claude. Groq LPU (чемпион TTFT ~80мс) — облако США + слабый русский Llama + нет tool-экосистемы → максимум опциональный Talker для чистой болтовни.
- **Естественность vs латентность в TTS — прямой конфликт.** Самый выразительный TTS (ElevenLabs v3) сам вендор объявляет НЕ для realtime (даже WebSocket-стрим не поддержан). Нельзя взять «максимум эмоции» И «<300мс» в чистом TTS. Цифры вендоров по TTFB противоречивы (Cartesia 40–90мс заявлено vs 640мс намерено async.com) — **обязателен свой замер из РФ-канала**.
- **Стоимость realtime-минут.** OpenAI Realtime перезаряжает все прошлые токены каждый ход → длинная сессия раздувается до $1.50+/мин на 30-мин звонке — болезненно для стендапа. Локальный/каскадный путь этого лишён.
- **Приватность/санкции.** Любой зарубежный облачный S2S = аудио владельца в облако США + серый доступ из РФ (152-ФЗ). Yandex SpeechKit Realtime — РФ-приватно и без VPN, но это тот же cascade (<1с), а не sub-300мс full-duplex.
- **full-duplex + backchannel честно недостижимы каскадом** — только заготовки по таймеру; истинный overlap даёт лишь S2S-модель.

---

## 8. Рекомендация

**Целевая архитектура:** гибрид **«Fast Talker (Haiku/локальный) + Slow Thinker (Claude-каскад в фоне)»** на клиенте RTX 5080, с эндпоинтинг-моделью и эмоц. стрим-TTS — сохраняя Claude-мозг, 100+ инструментов и РФ-приватность. Полный Grok-паритет как цель **не ставить** (архитектурная стена); цель — «резко живее», sub-second на разговоре, честный фон на задачах.

**Конкретный первый шаг (одна неделя, максимальная отдача):**
> Внедрить **Pipecat Smart Turn v3** (локальная endpointing-модель, русский, 12мс, 8 МБ, Apache) рядом с текущим VAD на клиенте — заменить/дополнить эвристический эндпоинтинг настоящей моделью «конец хода или пауза». Это убирает главный walkie-talkie-лаг (~секунду фикс-тишины перед каждым ответом) бесплатно, приватно и без единой правки облачного мозга.

Параллельно в том же спринте — повесить **Haiku 4.5 на conversational-ветку** (мгновенный Talker) и вернуть **осознанный cancel-safe backchannel** на долгих ходах. Эти три изменения дают самый большой скачок «живости» и одинаково работают для дейли-стендапа и обычного разговора. Дальше — по этапам плана §6: спекуляция на partial-STT → WebRTC → loopback-AEC → локальный S2S-фронт (после теста русского Qwen-Omni и, для 30B, апгрейда GPU до 24GB+).

---

## Источники

- https://x.ai/news/grok-voice-think-fast-1
- https://x.ai/news/grok-voice-agent-api
- https://aiinsightsnews.net/grok-voice-mode/
- https://docs.x.ai/developers/model-capabilities/audio/voice
- https://docs.pipecat.ai/api-reference/server/services/s2s/grok
- https://www.leadlock.ai/blog/grok-2-voice-agent/
- https://i10x.ai/news/grok-voice-agent-api-launch-analysis
- https://binary.ph/2026/04/18/build-real-time-speech-to-speech-voice-agents-with-the-grok-voice-agent-api-latency-first-guide/
- https://aitoolsrecap.com/Blog/grok-voice-think-fast-1-0-release-xai-2026
- https://www.evalgent.com/blog/xai-grok-voice-agent
- https://openai.com/index/introducing-gpt-realtime/
- https://developers.openai.com/api/docs/models/gpt-realtime
- https://developers.openai.com/api/docs/supported-countries
- https://www.marktechpost.com/2026/07/06/openai-gpt-realtime-2-1-mini-reasoning-realtime-api/
- https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions
- https://platform.openai.com/docs/guides/realtime-vad
- https://aireiter.com/blog/openai-realtime-api-pricing
- https://hamming.ai/blog/are-speech-to-speech-models-ready-to-replace-cascade-models
- https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture
- https://rtcleague.com/blogs/pipeline-vs-realtime-voice-agent-architecture
- https://artificialanalysis.ai/speech-to-speech
- https://artificialanalysis.ai/models/claude-4-5-haiku/providers
- https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-2-5-native-audio/
- https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-3-1-flash-live/
- https://ai.google.dev/gemini-api/docs/live-api
- https://cloud.google.com/blog/topics/developers-practitioners/how-to-use-gemini-live-api-native-audio-in-vertex-ai
- https://elevenlabs.io/blog/conversational-ai-2-0
- https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm
- https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow
- https://elevenlabs.io/blog/introducing-claude-37-sonnet-in-elevenlabs-conversational-ai
- https://elevenlabs.io/blog/eleven-v3
- https://elevenlabs.io/docs/overview/models
- https://docs.livekit.io/agents/models/realtime/plugins/xai/
- https://livekit.com/blog/solving-end-of-turn-detection
- https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection
- https://livekit.com/blog/improved-end-of-turn-model-cuts-voice-ai-interruptions-39
- https://docs.livekit.io/agents/logic/turns/turn-detector/
- https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/
- https://huggingface.co/pipecat-ai/smart-turn-v3
- https://huggingface.co/pipecat-ai/smart-turn-v2
- https://inworld.ai/resources/what-is-semantic-vad
- https://krisp.ai/blog/turn-taking-for-voice-ai/
- https://www.emergentmind.com/topics/moshi-a-speech-text-foundation-model
- https://github.com/kyutai-labs/moshi
- https://huggingface.co/kyutai/moshiko-pytorch-bf16
- https://www.spheron.network/blog/speech-to-speech-gpu-cloud-moshi-sesame-csm-hertz-dev/
- https://localaimaster.com/blog/moshi-realtime-speech-guide
- https://github.com/QwenLM/Qwen3-Omni
- https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct
- https://stable-learn.com/en/qwen3-omni-introduction/
- https://github.com/qwenlm/qwen2.5-omni
- https://arxiv.org/html/2509.17765v1
- https://arxiv.org/html/2511.07397v3
- https://arxiv.org/html/2601.19952v1
- https://arxiv.org/pdf/2605.13360
- https://arxiv.org/html/2509.14515v1
- https://arxiv.org/pdf/2507.23159
- https://arxiv.org/pdf/2412.02612
- https://arxiv.org/html/2512.18706
- https://github.com/FunAudioLLM/CosyVoice
- https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B
- https://funaudiollm.github.io/cosyvoice2/
- https://github.com/snakers4/silero-models
- https://www.cartesia.ai/sonic
- https://async.com/blog/tts-latency-vs-quality-benchmark/
- https://datarootlabs.com/blog/text-to-speech-models
- https://aistudio.yandex.ru/docs/ru/speechkit/tts/
- https://aistudio.yandex.ru/docs/ru/speechkit/release-notes-tts.html
- https://aistudio.yandex.ru/en/ai-speech
- https://yandex.cloud/en/services/speechkit
- https://sberdevices.ru/gigachat/
- https://tadviser.com/index.php/Product:Sber_Salyut_Virtual_assistants
- https://platform.claude.com/cookbook/third-party-elevenlabs-low-latency-stt-claude-tts
- https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency
- https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture
- https://dev.to/cloudx/cracking-the-1-second-voice-loop-what-we-learned-after-30-stack-benchmarks-427
- https://introl.com/blog/voice-ai-infrastructure-real-time-speech-agents-asr-tts-guide-2025
- https://introl.com/blog/groq-lpu-infrastructure-ultra-low-latency-inference-guide-2025
- https://explore.n1n.ai/blog/how-openai-scales-low-latency-realtime-voice-ai-2026-05-05
- https://www.coval.ai/blog/voice-ai-latency
- https://speko.ai/blog/s2s-vs-cascaded
- https://deepgram.com/learn/speech-to-speech-vs-cascade-voice-agent-architecture
- https://www.bankinfosecurity.com/openai-drops-chatgpt-access-for-users-in-china-russia-iran-a-25631
- https://www.squirepattonboggs.com/insights/publications/eu-sanctions-update-revised-restrictions-on-the-provision-of-services-to-russia/