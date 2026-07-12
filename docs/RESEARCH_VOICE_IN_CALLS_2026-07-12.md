# Джарвис на созвоне: может ли ассистент сам вести дейли-стендап в СберДжаз

*Единый инженерный отчёт по 7 исследовательским измерениям. Дата: 2026-07-11.*

---

## 1. TL;DR

Технически — **реализуемо, но НЕ в постановке «неотличимый живой коллега»**; реалистичная цель — **полу-скриптованный докладчик с видимыми швами** плюс режим суфлёра. Три из пяти технических слоёв фактически решены (аудио-инъекция в звонок, клон голоса владельца, захват+STT входящего аудио) и частично уже есть в кодовой базе Jarvis (WASAPI-сайдкар, VAD, barge-in, пофразный стриминг TTS). **Стена — не в одном месте, а в трёх:** (1) латентность каскада STT→LLM→TTS (генерация Opus 2-13с против требуемых <500мс для живого пинг-понга) убивает интерактивный диалог, но НЕ мешает заранее подготовленному монологу-апдейту; (2) многосторонний turn-taking/диаризация/адресация в групповом звонке — research-grade (~81% precision), надёжно не решается; (3) правовой блокер 152-ФЗ — обработка голосов коллег требует отдельного письменного согласия каждого (с 01.09.2025), а «тихий двойник» без раскрытия — правовой серый плюс репутационный удар. **Оценка усилий:** MVP-суфлёр — дни-недели на существующем стеке; полу-автономный докладчик дейли — недели; «живой full-duplex коллега» — крупный R&D вне текущей архитектуры (нужна русская S2S-модель, которой на янв-2026 в опенсорсе нет). **Вывод: делать стоит как суфлёр → полу-скриптованный докладчик, только с раскрытием и согласием команды; «неотличимо вести живой дейли» — не обещать.**

---

## 2. Архитектура end-to-end

### Топология потоков

```
                          ┌─────────────────── ОБЛАКО ───────────────────┐
                          │                                              │
  [Микрофон владельца] ──┐│  STT (Deepgram/Yandex v3)                    │
                         ├┼─► канал "владелец" ──►┐                      │
  [Loopback звонка] ─────┘│                       │   LLM-оркестратор    │
   (речь коллег из         │  STT (2-й стрим)      ├─► дейли (Claude,     │
    динамиков/шины)  ──────┼─► канал "удалённые" ──┘   роль-промпт +     │
                          │   + диаризация spk_0..3    стейт-машина      │
                          │                            повестки)         │
                          │                              │               │
                          │                              ▼               │
                          │                       TTS (голос владельца:  │
                          │                       XTTS-v2 / CosyVoice2   │
                          └──────────────────────  локально ИЛИ Yandex)  ┘
                                                         │
        ┌──────────────────── КЛИЕНТ / САЙДКАР (Windows) ─────────────────┐
        │  C#-сайдкар (NAudio):                                           │
        │   • WasapiLoopbackCapture ── захват аудио звонка → STT          │
        │   • WasapiOut → "CABLE Input" ◄── PCM TTS (не трогая дефолт)    │
        │  AEC/gate: свой TTS в loopback НЕ транскрибировать              │
        └────────────────────────────────────────────────────────────────┘
                                                         │
                              VB-CABLE Output = "микрофон" ► выбран в СберДжаз
```

### Где что живёт

| Слой | Где | Компонент |
|---|---|---|
| Захват аудио звонка | **Клиент/сайдкар** | NAudio `WasapiLoopbackCapture` в существующем `apps/sidecar-win` (не Electron `getDisplayMedia` — нестабилен) |
| Рендер TTS в звонок | **Клиент/сайдкар** | NAudio `WasapiOut` → конкретный MMDevice «CABLE Input», без смены системного дефолта |
| STT + диаризация | **Облако** (или локально) | Deepgram Nova-3/Flux ИЛИ Yandex SpeechKit v3 (152-ФЗ); диаризация — провайдер v1 или локальный Sortformer |
| LLM-оркестратор | **Облако** | Claude (текущий стек), роль ведущего = system-prompt + стейт-машина повестки |
| Синтез голоса | **Локально (RTX 5080)** или облако | XTTS-v2 / CosyVoice 2 (клон+приватность) с fallback на Yandex |
| Маршрутизация | **ОС Windows** | VB-CABLE / VoiceMeeter (раздельные шины mic/call) |

### Латентный бюджет (сквозной, на реплику)

| Этап | Задержка | Комментарий |
|---|---|---|
| Захват + буфер loopback | ~80-200 мс | NAudio |
| Маршрутизация VB-CABLE | ~5-40 мс | буфер 256@48кГц = ~5мс; MME-дефолт 20-40мс — ничтожно |
| STT (Deepgram Nova-3/Flux) | ~100-300 мс | русский <300мс, Flux end-of-turn <400мс |
| Диаризация (Sortformer) | 0.32-1.04 с | Ultra-Low 0.32с / Low 1.04с |
| **LLM-ход (Opus)** | **2-13 с** | **ГЛАВНЫЙ вклад — узкое место** |
| TTS первый чанк | 150-300 мс | XTTS ~200мс / CosyVoice2 150мс — НЕ бутылочное горло |

**Итог:** «понять контекст, кто и что сказал» — ~0.7-1.5 с (с запасом для роли слушателя). «Ответить своей репликой» — доминирует LLM: **2-13 с**, что на порядок выше человеческого межреплийного зазора ~200 мс. Отсюда ключевой архитектурный вывод: **текст апдейта готовить ЗАРАНЕЕ** (из тикетов/коммитов/памяти §20), тогда латентность LLM не мешает — проигрывается готовый TTS по триггеру.

---

## 3. По слоям: инструменты-кандидаты, цифры, ограничения

### 3.1 Аудио-инъекция в СберДжаз (feasibility: ВЫСОКАЯ — почти нет стены)

- **VB-Audio Virtual Cable** (бесплатный, подписанный драйвер, Win10/11): создаёт пару «CABLE Input» (playback) / «CABLE Output» (capture). Всё, что рендерится в CABLE Input, приложение слышит как микрофон. App-agnostic паттерн, годами используется с Zoom/Teams/Meet/Discord.
- **NAudio (C#)** рендерит TTS в конкретный endpoint (`WasapiOut` на MMDevice «CABLE Input») — **без смены системного дефолта**, ложится прямо на существующий сайдкар.
- **VoiceMeeter** — виртуальный микшер: смешать TTS Джарвиса + реальный микрофон владельца в один виртуальный мик, раздельные шины A1/B1 — упрощает развязку эха.
- **Open-source Virtual-Audio-Driver (MIT)** — если нужен полностью открытый/контролируемый драйвер без внешнего вендора.
- **Латентность маршрутизации** — единицы-десятки мс, на восприятие речи не влияет.
- **СберДжаз НЕ блокирует виртуальные устройства** — только неблокирующее предупреждение «Выбрано устройство ввода звука не как в системе». Выбор персистится между встречами. Детекта «это не настоящий мик» в корп-мессенджерах не встречается.

**Ограничения/оговорки:**
1. Отключить в СберДжаз «Шумоподавление» и «Авторегулировку микрофона» — иначе портят ровный TTS.
2. Развести маршруты, чтобы входящее аудио звонка НЕ попадало обратно в мик-канал (петля/эхо): call-audio → колонки/наушники или отдельный кабель для STT; mic = кабель с TTS.
3. Программное переключение мика внутри приложения на лету — хрупко (недокументированный `IPolicyConfig`, NirSoft SoundVolumeView); надёжнее — **пользователь один раз выбирает «CABLE Output» микрофоном**, Джарвис управляет только ПОТОКОМ (говорить/молчать).

### 3.2 Real-time TTS с клоном голоса владельца (feasibility: РЕАЛИЗУЕМО — самая зрелая часть)

| Кандидат | Первый чанк | Русский | Клон | VRAM/лиценз. | Вердикт |
|---|---|---|---|---|---|
| **XTTS-v2** (локально) | ~200 мс стрим | ✅ 17 языков | 6 сек реф. | 4-6 ГБ, CPML non-comm. | ✅ зрелый выбор |
| **CosyVoice 2** (локально) | **150 мс** | ✅ 9 языков | zero-shot | 0.5B, open | ✅ лучшая латентность |
| F5-TTS (локально) | ~2.8с нестрим | ✅ но просодия слабее | да | ~3 ГБ, CC-BY-NC | просодия RU минус |
| Cartesia Sonic | ~90 мс TTFA | ✗ слабый | 3 сек | облако США | не для РФ |
| ElevenLabs Flash 2.5 | ~150 мс TTFA | ✅ | 30 сек | облако США | приватность/оплата |
| Yandex SpeechKit Brand Voice | <1с | ✅ родной | **20-40 мин записи** | облако РФ | клон не on-the-fly |
| Silero TTS v5 | быстрый CPU | ✅ лучший RU open | ✗ нет клона | CPU | fallback без клона |

**Рекомендация:** локальный **XTTS-v2 или CosyVoice 2** на RTX 5080 (приватность + русский + zero-shot клон по короткому сэмплу) с fallback на текущий Yandex-путь. Облачные ultra-low-latency (Cartesia/ElevenLabs) — **не брать**: РФ-доступ/оплата затруднены, голос уходит на чужие серверы, у Cartesia русский слабый.

**Юридически:** клон СОБСТВЕННОГО голоса владельца по его согласию — чисто (self-consent на свою биометрию), 152-ФЗ здесь не стена.

**Ограничение просодии:** текущий Yandex filipp умеет только strict-эмоцию (good/evil не умеет), теги `[warmly]` срезаются; полная эмоция — голос jane. Для монотонного зачитывания стендапа сойдёт, но плоская просодия + отсутствие пауз-филлеров выдают синтез.

### 3.3 STT входящей речи + диаризация (feasibility: 80% решаемо)

- **Захват** — NAudio `WasapiLoopbackCapture` в C#-сайдкаре (bit-perfect цифровой поток всего вывода, без эха/шума), PCM16 16кГц чанками — ровно как уже сделано для голоса владельца. Electron-путь (`getDisplayMedia`/`desktopCapturer`) на Windows нестабилен (NotSupportedError, Error 263).
- **Бесплатный сплит «владелец vs удалённые»** — микрофон = один трек, loopback = все удалённые разом. Channel-diarization, точность выше акустической, стоимость нулевая. Так строят Backchannel, MeetStream, Superwhisper.
- **Потоковый STT русского** — Deepgram Nova-3/Flux (<300мс, Flux end-of-turn <400мс), ~$0.46/час. **Ограничение:** потоковая диаризация только v1 (v2 в стриме кидает ошибку), `speaker_confidence` в стриме не возвращается. Поднять второй Deepgram-стрим на loopback-канал.
- **Комплаенс-путь (152-ФЗ):** Yandex SpeechKit v3 `recognizeStreaming` (REAL_TIME, `speaker_labeling`, юрисдикция РФ, русский родной). Диаризация слабее и хуже документирована по латентности.
- **Локальная диаризация нескольких участников:** NVIDIA Streaming Sortformer (`nvidia/diar_streaming_sortformer_4spk-v2`, 08.2025) на RTX 5080. Конфиги: Ultra-Low 0.32с (RTF 0.18), Low 1.04с (RTF 0.093, DER 13.24 на DIHARD III). **Потолок 4 говорящих** (5+ деградирует), оптимизирована под английский (для русского авторы рекомендуют fine-tune). Запуск через NeMo/Riva (PyTorch) → **отдельный Python-сайдкар** (в проекте уже был DLL-конфликт onnxruntime↔sherpa в одном процессе — NeMo тем более изолировать).

**Реальная стена:** СберДжаз не отдаёт идентичности участников (нет публичного bot-API), loopback = смешанный моно-поток → акустическая диаризация обязательна и принципиально несовершенна (overlap, 4-спикерный потолок, нестабильные метки spk_0..3 при уходе/приходе). Для дейли на 3-5 человек — приемлемо; на большом созвоне метки поплывут.

### 3.4 Оркестрация turn-taking (feasibility: частично, с чёткой стеной)

- **Архитектура — chained pipeline STT→LLM→TTS**, а не speech-to-speech. Для single-user desktop это правильный выбор (~$0.15/мин против $0.30-1.50+/мин у OpenAI Realtime, нет GPU-требований, легко менять компоненты). Стек Jarvis уже совпадает с рекомендуемым. Self-hosted S2S нереален (Ultravox v0.7 355B требует B200/несколько H100).
- **Endpointing:** у Jarvis уже есть Deepgram `speech_final` (~350-400мс) — на уровне лучших практик. Апгрейд — model-based turn-detection (LiveKit Turn Detector v1 из Qwen2.5-0.5B, CPU, роняет p95 с 1.2-1.4с до 500-650мс; Pipecat Smart Turn v2/v3 локально ~65мс).
- **Multi-party turn-taking** (КОГДА / КОМУ / ЧТО в группе) — **только research, не npm-пакет.** ModeratorLM (arXiv 2606.13544): precision 79-81%, recall 74-82%, ложные перебивания 14%→1-3%, на NOTSOFAR-1 precision 81%. Надёжного open-source нет.
- **Практичный путь для дейли — сценарный конечный автомат повестки + роль-промпт** (не общий semantic turn-taking). MeetGeek «AI Scrum Master» (31.10.2025) доказал паттерн: автономно ведёт стендап по predefined workflow как конфигурируемый цифровой участник. Для Jarvis: вести дейли через явную повестку-стейтмашину (round-robin «вчера/сегодня/блокеры»), свободную дискуссию «встрять когда уместно» — НЕ давать.
- **Backchanneling** («угу», «понял») — нерешённая деталь: Smart Turn V2 не отличает его от перебивания (78.67% на полных ходах). Эвристика: короткая реплика + не адресована агенту → игнор.
- **False-barge-in** — главный сбой в шумном групповом звонке; порог <2% (>5% «сломано») достигается 3-слойным VAD, но это для телефонии 1:1, не для митинга.

### 3.5 Платформа СберДжаз (feasibility: два пути)

**Путь A — родной Web SDK `@salutejs/jazz-sdk-web`** (npm, TypeScript, демо `salute-developers/jazz-web-sdk-demo`):
- Классы `JazzSdk`, `JazzClient`, `JazzRoom`, `LocalDevicesManager`. `client.join({conferenceId, password})`.
- **Ключевое:** `setUserAudioInput(stream: MediaStream)` заменяет микрофон на произвольный MediaStream → TTS Яндекса через WebAudio `MediaStreamDestination` подаётся как «микрофон». Приём речи всех участников → в STT. **Полный дуплекс через один Web SDK, headless возможен** (Jarvis сам Electron/Chromium).
- **Стена не техническая:** нужен платный **SDK Key только юрлицу** (Бизнес 8000₽/год, Корпоративный 11000₽/год, через договор со Сбером) + транспорт-токен `createSdkToken(SDK_KEY,...)` на сервере.

**Путь B — обход без API (VB-CABLE поверх штатного клиента):**
- TTS → CABLE Input (микрофон СберДжаз), звук звонка → CABLE Output → STT. Работает с любым клиентом без API.
- **Минусы:** нужен залогиненный клиент; подключение/mute — GUI-актуаторы (UIA/скриншот), хрупко; эхо-развязка (свой TTS не в свой STT — известная AEC-проблема Jarvis).

**Публичного bot-join-by-link API как у Zoom/Recall.ai у СберДжаз НЕТ**, готовых сторонних говорящих ботов нет (боты типа mymeet.ai заходят с выключенным микрофоном — только слушают). Recall.ai (Output Media, стрим audio/video в звонок) СберДжаз не поддерживает.

**Рекомендация:** прототип на VB-CABLE (доступен сразу), целевое — Web SDK (чистая инжекция без ОС-маршрутизации, headless).

---

## 4. Этап-план: MVP → полноценно

### Этап 0 — Суфлёр (даёт ~80% ценности, минимум риска)
**Джарвис слушает дейли и подсказывает владельцу текстом/тихим голосом в ухо — сам в звонок НЕ говорит.**
- Захват loopback (NAudio, существующий сайдкар) + STT + грубая диаризация «я vs они».
- LLM собирает контекст, готовит апдейт из §20-задач/коммитов/памяти, показывает на экране/шепчет.
- **Латентность LLM не критична** (владелец сам говорит), turn-taking не нужен, **голоса коллег обрабатываются только для суфлирования владельцу — но всё равно требуют согласия по 152-ФЗ** (см. §5).
- Правовой риск минимален: никто не выдаёт себя за человека, нет синтетического участника.

### Этап 1 — Полу-скриптованный докладчик
**Джарвис зачитывает заранее подготовленный апдейт по триггеру (имя/пауза) через VB-CABLE.**
- Клон голоса владельца (XTTS-v2/CosyVoice2 локально).
- Текст стендапа генерируется ЗАРАНЕЕ → латентность LLM обходится.
- Триггер: диаризация распознала «Антон, что у тебя?» ИЛИ пауза после предыдущего.
- Отвечает на 1-2 простых ожидаемых уточнения с заметной паузой.
- **Обязательно:** раскрытие в начале встречи + согласие команды (см. §5).

### Этап 2 — Полу-автономный участник
- Web SDK СберДжаз (`setUserAudioInput`) вместо VB-CABLE — чистая инжекция, headless.
- AEC против звука созвона (loopback как reference → WebRTC APM).
- Model-based endpointing, стейт-машина повестки, локальный Sortformer.
- Живой ответ на неожиданные вопросы — с честными «швами» (пауза 2-13с).

### Этап 3 — «Живой коллега» (крупный R&D, вне текущей архитектуры)
- Переход на S2S-модель (латентность <300мс: Moshi ~160-200мс, PersonaPlex 205мс) — **но русской опенсорс-S2S на янв-2026 нет.** Полнодуплекс на одном ПК нецелесообразен (H100/B200). **Не рекомендуется как ближайшая цель.**

---

## 5. Риски и пределы

### Технические
- **Латентность (главная стена интерактива):** каскад + облачный Opus = 2-13с против человеческого зазора ~200мс и порога «говорю с роботом» >500-700мс. Годится для монолога-апдейта, ломается на живом пинг-понге вопросов.
- **Естественность / uncanny valley:** плоская просодия (Yandex filipp — только strict), отсутствие бэкченнелинга и пауз-филлеров («эээ», «ну») выдают синтез. Клон-TTS (XTTS/CosyVoice) естественнее, но эмоциональная просодия ограничена.
- **Реалтайм-рефлексы:** многосторонний turn-taking, адресация («это ко мне?»), false-barge-in в шумном групповом звонке — не решены даже у лидеров (~81% precision). Все бенчмарки full-duplex тестируют 1:1, не группу.
- **Диаризация:** потолок 4 говорящих (Sortformer), нестабильные метки при уходе/приходе, loopback = смешанный моно.
- **Детект виртуального микрофона:** практически отсутствует — максимум неблокирующее предупреждение. Это НЕ риск.
- **AEC:** браузерный echoCancellation не гасит внешнее медиа (звук созвона из колонок) — открытая проблема Jarvis; без loopback-AEC ассистент транскрибирует участников как команды.

### Этико-правовые (жёсткие блокеры)
- **Голоса коллег = биометрические ПД** (ФЗ №152, №572-ФЗ). Их STT-обработка Джарвисом без согласия нарушает закон. **С 01.09.2025 (156-ФЗ) согласие на биометрию — ОТДЕЛЬНЫЙ письменный документ**; присутствие бота в списке участников согласием НЕ считается. Это касается даже режима суфлёра.
- **Нет отдельного «права на голос» в ГК РФ:** законопроект №718834-8 (ст. 152.3) НЕ поддержан Советом по кодификации (10.2024) и Кабмином (01.2025). Защита лоскутная: 152-ФЗ (биометрия), ст. 1315 ГК (смежные права, компенсация 10 тыс-5 млн ₽ — защищает запись, не голос), ст. 152.1 по аналогии.
- **Клон СВОЕГО голоса** — легально (self-consent). Уголовный риск ст. 159 УК возникает только при ОБМАНЕ контрагентов.
- **Нераскрытый ИИ-двойник** — правовой серый + репутационный удар («бот вместо меня» подрывает аутентичность). Мировая норма движется к обязательному раскрытию (ELVIS Act, NO FAKES Act, SAG-AFTRA). Иллюстрация масштаба: Сингапур, 03.2025 — финдиректор перевёл ~$499k после Zoom-звонка с полностью ИИ-сгенерированными участниками.
- **Судебный тренд:** Cruz v. Fireflies.AI (12.2025), 4 иска против Otter.ai (слушание 15.07.2026) — именно захват чужих голосов, а не синтез своего, горячая мишень.
- **Сбер — банк со строгим комплаенсом:** внутренние политики почти наверняка запрещают синтетических/неавторизованных участников на внутренних встречах — слой риска сверх 152-ФЗ.

**Этичный коридор:** (1) явное раскрытие «отвечает ИИ-ассистент Антона»; (2) предварительное письменное согласие команды на обработку голосов; (3) владелец остаётся ответственным и сам подтверждает обязательства; (4) НЕ использовать на внешних встречах / с новыми контрагентами / где принимаются финансовые/юридические решения. «Тихий двойник, выдающий себя за человека» — **не реализовывать.**

---

## 6. Рекомендация

**Стоит ли:** да, как **суфлёр (Этап 0) → полу-скриптованный докладчик (Этап 1)**, с раскрытием и согласием команды. «Неотличимо вести живой дейли» не обещать — это упирается в латентность каскада, нерешённый групповой turn-taking и 152-ФЗ.

**С чего начать:** режим суфлёра. Он даёт ~80% ценности (Джарвис знает контекст созвона, готовит апдейт, подсказывает), почти не несёт правового риска активного участия и переиспользует уже готовую инфраструктуру. Параллельно — оформить согласие команды на обработку голосов (обязательно даже для суфлёра).

**Где встроить в текущую архитектуру Jarvis:**
- **Сайдкар (`apps/sidecar-win`):** добавить `WasapiLoopbackCapture` (захват аудио звонка → PCM16-чанки на сервер, как уже для голоса владельца) и `WasapiOut` в endpoint «CABLE Input» (рендер TTS в кабель без смены дефолта). Это интеграция, не R&D — половина инфраструктуры (WASAPI/VAD/barge-in/пофразный стриминг) уже есть.
- **Voice-pipeline:** второй STT-канал (loopback), gate/AEC чтобы Джарвис не транскрибировал свой TTS (класс проблемы уже известен в проекте — `echoCancellation`, barge-grace).
- **Актуаторы:** новый актуатор `call.*` (join/mute/speak-into-call через VB-CABLE поток; на Этапе 2 — Web SDK `setUserAudioInput` в скрытом окне Electron). Подключение/mute штатного клиента — через существующие UIA-актуаторы.
- **Диаризация:** отдельный Python-сайдкар (Sortformer/NeMo) — по образцу уже сделанного speaker-сайдкара (sherpa изолирован в дочернем процессе из-за DLL-конфликта onnxruntime); NeMo тем более изолировать.
- **Оркестрация:** роль ведущего дейли — system-prompt + стейт-машина повестки поверх §20-реестра задач и памяти (текст апдейта готовится заранее из задач/коммитов).
- **TTS:** локальный XTTS-v2/CosyVoice2 на RTX 5080 как новый провайдер рядом с текущим Yandex (fallback).

---

## Источники

**Инъекция TTS-аудио / виртуальный микрофон:**
- https://developers.sber.ru/help/jazz/guide/troubleshooting
- https://developers.sber.ru/help/jazz/guide/call-management
- https://voicemeeter.com/use-voicemeeter-with-vb-audio-cable-for-skype-zoom-or-discord/
- https://voicemeeter.com/how-to-optimize-your-latency-in-voicemeeter/
- https://ttsvoicewizard.com/docs/getting-started/VirtualCable
- https://github.com/VRCWizard/TTS-Voice-Wizard/wiki/Virtual-Cable
- https://github.com/VirtualDrivers/Virtual-Audio-Driver
- https://learn.microsoft.com/en-us/answers/questions/1515984/how-to-programmatically-stream-audio-to-microphone
- https://www.w3tutorials.net/blog/how-can-i-programmatically-set-the-default-input-and-output-audio-device-for-an-application/
- https://blog.nirsoft.net/2020/05/29/set-default-audio-device-of-specific-application-from-command-line-on-windows-10/
- https://community.zoom.com/t5/Zoom-Meetings/Audio-Garbled-When-Sharing-Audio-from-Microphone-OBS-VB-Audio/td-p/237734
- https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0074698
- https://github.com/sgiurgiu/DefaultAudioChanger

**Real-time TTS / клон голоса:**
- https://www.codesota.com/guides/tts-models
- https://www.inferless.com/learn/comparing-different-text-to-speech---tts--models-part-2
- https://localaimaster.com/blog/f5-tts-setup-guide
- https://www.siliconflow.com/articles/en/best-open-source-models-for-voice-cloning
- https://www.cartesia.ai/vs/cartesia-vs-elevenlabs/
- https://burki.dev/blog/41-cartesia-vs-elevenlabs-tts
- https://www.codesota.com/speech/elevenlabs-vs-cartesia
- https://github.com/fishaudio/fish-speech
- https://openaudios1.com/
- https://arxiv.org/html/2603.08823v1
- https://funaudiollm.github.io/cosyvoice2/
- https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B
- https://www.spheron.network/blog/self-host-voice-cloning-gpu-cloud-xtts-f5-tts-openvoice-v2/
- https://huggingface.co/coqui/XTTS-v2
- https://plaan.ai/yandex-speechkit/
- https://pimenov.ai/knowledge/silero-models-tts-stt-vad-russkij-yazyk/
- https://vc.ru/dev/2315216-silero-tts-v5-besplatnyj-sintez-rechi

**STT + диаризация:**
- https://deepgram.com/learn/introducing-flux-multilingual
- https://developers.deepgram.com/docs/diarization
- https://developers.deepgram.com/docs/measuring-streaming-latency
- https://deepgram.com/product/speech-to-text/russian
- https://deepgram.com/learn/nextgen-speaker-diarization-and-language-detection-models
- https://aistudio.yandex.ru/docs/en/speechkit/stt/streaming.html
- https://github.com/yandex-cloud/docs/blob/master/en/speechkit/stt-v3/api-ref/grpc/Recognizer/recognizeStreaming.md
- https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2
- https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/
- https://arxiv.org/html/2507.18446v1
- https://github.com/alectrocute/electron-audio-loopback
- https://alec.is/posts/bringing-system-audio-loopback-to-electron/
- https://github.com/naudio/NAudio/blob/master/Docs/WasapiLoopbackCapture.md
- https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
- https://www.assemblyai.com/blog/multichannel-speaker-diarization
- https://backchannel.page/
- https://www.isca-archive.org/interspeech_2025/medennikov25_interspeech.pdf

**Оркестрация turn-taking / голосовые агенты:**
- https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection
- https://docs.livekit.io/agents/build/turns/turn-detector/
- https://livekit.com/blog/solving-end-of-turn-detection
- https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture
- https://www.evalgent.com/blog/full-duplex-voice-agents
- https://arxiv.org/abs/2606.13544
- https://arxiv.org/html/2606.13544v2
- https://github.com/pipecat-ai/smart-turn
- https://developers.cloudflare.com/workers-ai/models/smart-turn-v2/
- https://docs.pipecat.ai/pipecat-cloud/guides/smart-turn
- https://www.globenewswire.com/news-release/2025/10/31/3178600/0/en/meetgeek-announces-launch-of-ai-voice-agents-to-autonomously-participate-in-virtual-meetings.html
- https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent
- https://www.pyannote.ai/blog/diarization-benefits-for-your-voice-ai-solutions
- https://futureagi.com/blog/how-to-optimize-livekit-latency-2026/

**СберДжаз / SDK / бот-паттерны:**
- https://developers.sber.ru/docs/ru/jazz/sdk/web/overview
- https://developers.sber.ru/docs/ru/jazz/sdk/web/modules
- https://developers.sber.ru/docs/ru/jazz/sdk/sdk-key
- https://github.com/salute-developers/jazz-web-sdk-demo
- https://developers.sber.ru/portal/products/salutejazz/sdk
- https://developers.sber.ru/portal/products/salutejazz/possibilities
- https://habr.com/ru/companies/sberbank/articles/673930/
- https://docs.recall.ai/docs/output-audio-in-meetings
- https://docs.recall.ai/docs/stream-media
- https://www.recall.ai/product/meeting-bot-api
- https://www.recall.ai/blog/zoom-sdk-ai-voice-agent
- https://github.com/pattern-ai-labs/agentcall
- https://agentcall.dev/blog/how-to-make-ai-agent-join-a-meeting
- https://www.toughtongueai.com/blog/build-voice-ai-agent-google-meet-zoom
- https://developers.zoom.us/blog/realtime-media-streams-ai-orchestration/
- https://help.livevoice.io/article/146-using-vb-audio-virtual-cable-to-send-audio-from-zoom-or-ms-teams-to-livevoice
- https://help.mymeet.ai/ru/articles/31-salute-jazz
- https://mymeet.ai/ru/blog/what-is-salutejazz

**Full-duplex модели / кейсы / пределы:**
- https://dev.to/programmerraja/2025-voice-ai-guide-how-to-make-your-own-real-time-voice-agent-part-1-45hl
- https://arxiv.org/pdf/2602.06053
- https://inworld.ai/resources/best-speech-to-speech-model
- https://ai.ksopyla.com/posts/voice-to-voice-models-2026-review/
- https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/
- https://vac.muzychenko.net/en/
- https://github.com/QiCuiHub/discord-audio-pipe
- https://www.meetjamie.ai/blog/bot-free-ai-meeting-assistant
- https://luonghongthuan.com/en/blog/pipecat-voice-agent-production-scalable-guide/
- https://www.forasoft.com/blog/article/livekit-ai-agents-guide

**Этика / право / 152-ФЗ:**
- https://www.consultant.ru/law/podborki/zapis_golosa_personalnye_dannye/
- https://ic-tech.ru/blog/faq/questions-152fz/nuzhno-li-soglasie-na-ispolzovanie-golosa-sotrudnika-v-audiozapisyah/
- https://telecom.perm.ru/2025/06/neobhodimo-li-pri-audiozapisi-telefonnyih-razgovorov-poluchat-pismennoe-soglasie-subekta-na-obrabotku-ego-biometricheskih-personalnyih-dannyih/
- https://www.consultant.ru/legalnews/26401/
- https://rapsinews.ru/legislation_news/20240916/310243711.html
- https://tass.ru/ekonomika/21878475
- https://www.interfax.ru/russia/1003742
- https://mosdigitals.ru/blog/krazha-golosa-i-ai-klonirovanie-pravovaya-zashhita-diktorov-ot-sinteza-rechi
- https://circleback.ai/blog/recording-consent-for-ai-meeting-notes
- https://www.reedsmith.com/our-insights/blogs/employment-law-watch/102ls2n/the-legality-of-ai-powered-recording-and-transcription/
- https://harris-sliwoski.com/blog/deepfakes-voice-cloning-and-ai-impersonation-the-global-rules-are-already-here-and-they-dont-agree/
- https://www.mofo.com/resources/insights/250922-digital-avatars-deep-dive-series-navigating
- https://developers.sber.ru/help/jazz/recording-the-conference
- https://www.forbes.com/councils/forbesbusinesscouncil/2026/06/25/what-ceos-should-know-about-ai-deepfakes-and-executive-impersonation/
- https://workspace.ru/blog/polnyy-gayd-po-personalnym-dannym-152-fz-novye-shtrafy-chastye-oshibki-i-trebovaniya-v-2025-godu/