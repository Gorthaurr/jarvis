# Джарвис и видео: просмотр, поиск момента, монтаж — план (2026-09-02)

> Контекст: запрос владельца «продумать план реализации просмотра видео Джарвисом, монтажа и прочего, посмотреть,
> реализовывалось ли это нейронками». Часть 1 — факты по коду (файл:строка), часть 2 — ресёрч сентября 2026 с
> источниками, дальше — честная оценка «что можем сегодня», план S/M/L, экономика и риски честности.
> Парный документ по ролям и сценариям: [USER_SCENARIOS_2026-09-02.md](USER_SCENARIOS_2026-09-02.md)
> (блогер/стример упираются ровно в «нет транскрипта локального файла» и «code_run ≤180 с» — см. там B2/B6/S7).
>
> Главный вывод в одну строку: у всех, кто сидит на Claude/GPT, «видео» = **локальный транскрипт с таймкодами +
> редкие кадры по таймкодам + ffmpeg как исполнитель**; нативно видео смотрит только Gemini. Для Джарвиса это
> три кирпича: локальный ASR (faster-whisper/Parakeet на RTX 5080, ~3 мин на час), `file_view` для кадра видео,
> фоновые задания дольше 180 с. Всё остальное — рецепты и правило честности «видел N кадров ≠ посмотрел».

## Часть 1. Что уже есть в коде (факты)

### Кирпичи, которые работают сегодня

| Кирпич | Где | Что даёт для видео |
|---|---|---|
| DOM-позиция плеера | `apps/server/src/brain/tools/handlers/browser.ts:279-285` | `browser_read` всегда отдаёт `[Плеер: currentTime/duration, играет/пауза]` из DOM, без движения мыши |
| seek/play/pause во вкладке | `apps/extension/background.js:1141-1147, 1733-1740`; `browser.ts:386` | `browser_act{intent:"seek", to/sec}` — точная перемотка |
| Ожидание таймкода | `browser-condition.ts:1-8`; `packages/protocol/src/actions.ts:72-78`; кап 230 с `dispatch.ts:753` | `wait_for{kind:"browser", prop:"currentTime", op:">=", value}` — «дождись 26:00» без LLM-раундов; персона учит этому (`persona.md:358-373`) |
| Зрение на экран | `apps/client/main/actuators/screen.ts:21` (MAX_EDGE 1568), `:75-90` (монитор переднего окна), `:115-120` (rect-кроп) | `screen_capture{rect,scale,monitor}` — кадр того, что играет сейчас |
| Дешёвые сенсоры | `sensors-cheap.ts:1-11` (OCR Windows.Media.Ocr), `screen_probe` (pHash 8×8, `packages/tools/src/index.ts:706`) | текст с экрана ~50-200 ток.; детектор «картинка сменилась» за $0 |
| Зрение на файл | `apps/client/main/actuators/file-view.ts:86-97` | PNG/JPEG/GIF/WEBP/страница PDF → image-блок; параллельный вызов нескольких `file_view` в одном раунде разрешён (`error-voice.ts:130-133`) |
| CLI-каталог | `system-profiler.ts:203` ffmpeg, `:205` yt-dlp, `:228` nvidia-smi, `:204` tesseract, `:230` magick | модель знает, что стоит на машине |
| Рецепты | `app-channels.ts:218-233` FFmpeg (verify = ffprobe, предупреждение про `-ss -c copy` по ключевым кадрам), `:553-566` yt-dlp (`-J`, `ytsearch`, `-x`), `:202-217` SMTC (позиция/статус любого плеера через WinRT) | процедурное знание в промпте |
| OBS | `actuators/obs.ts:1-9` | `obs_request` → `StartRecord/StopRecord` = «запиши экран в файл» программно |
| Бюджет контекста | `agent/index.ts:207` (image ≈ 2000 ток.), `:1520-1527` (SOFT 150K / HARD 185K), `:1788-1797` (KEEP_SCREENSHOTS=1, KEEP_DOC_IMAGES=2), `prune-images.ts` | старые кадры сворачиваются заглушкой; страница документа — честной «свёрнута, не устарела» |

### Чего нет — с адресом

1. **Видео как файл не открывается.** `file-view.ts:86-97` — нет ветки для mp4/mkv/webm; `unsupportedMessage` (`:175-190`) на видео отдаёт общий текст «сконвертируй в PNG», ни слова про ffmpeg-кадр.
2. **Нет транскрипции файла.** В `packages/tools/src/index.ts` только `audio_sessions`/`audio_set` (`:329, :335`). Локальный Whisper (`integrations/whisper-stt.ts:1-9, 38-39`) — transformers.js на CPU (q8), обслуживает ТОЛЬКО микрофон, не файлы.
3. **`code_run` живёт ≤180 с** (`code-runner.ts:47-52`: деф 30 с, кламп [5 с, 180 с]). Whisper на часовом файле (~3 мин) и перекодирование часа не влезают; фонового запуска с опросом нет.
4. **`wait_for` не умеет «файл появился/процесс завершился»** (`actions.ts:62-78`: ui/window/text/sound/gsi/browser; клиентский кап 120 с `sensors-cheap.ts:102`).
5. **`KEEP_DOC_IMAGES=2`** — из 12 кадров, показанных `file_view`, на следующий раунд доживут два. Многокадровое рассуждение — только в ОДНОМ раунде (параллельные `file_view`) или через контакт-лист.
6. **Рецепт yt-dlp не знает про субтитры** (`app-channels.ts:558-560`): модель должна сама помнить `--write-auto-subs`.
7. **Закон verify не страхует монтаж:** `code_run` — самоподтверждающийся (CLAUDE.md, §verify), verify-нудж после него не взводится; сверка результата ffmpeg держится только на рецепте (ffprobe), не на механике петли.

### Что проходимо цепочкой СЕГОДНЯ

| Сценарий | Проходимо? | Цепочка / затык |
|---|---|---|
| «Посмотри ролик (файл) и перескажи» | **Частично, без звука** | `code_run` ffmpeg `fps=1/60,tile=4x3` → PNG → `file_view` → пересказ по картинкам. Речь недоступна → пересказ = «что видно», не «о чём говорят» |
| «Перескажи ролик с YouTube» | **Да (по тексту)** | `code_run` yt-dlp `--write-auto-subs --sub-langs ru,en --skip-download` → `fs_read` → пересказ. Модели надо знать флаги самой |
| «Найди момент, где …» | **Да по речи YouTube; грубо по картинке** | таймкоды из json3-субтитров; по картинке — контакт-лист → уточняющие кадры `-ss` (2-3 раунда) |
| «Дождись таймкода / что сейчас на видео» | **Да** | `browser_read` + `wait_for{browser}` + `browser_act seek` |
| «Вырежи фрагмент» | **Да, ≤180 с работы** | ffmpeg `-ss/-to` (+перекодирование для точности) → ffprobe → (желательно) `file_view` кадра результата |
| «Сделай нарезку/шортс» | **Нет end-to-end** | нет транскрипта с таймкодами для локального файла → выбор фрагментов слеп; crop 9:16 и субтитры без ASR невозможны |
| «Добавь субтитры» | **YouTube — да; локальный файл — нет** | без ASR-файла; `pip install faster-whisper` внутри `code_run` теоретически возможен, но >180 с и хрупко |

## Часть 2. Как это делают у других (ресёрч, сентябрь 2026)

### Понимание видео

- **Gemini 3.x** — единственный из «большой тройки» с нативным видео: 1 кадр/с, ~100 ток/с (low) / ~300 ток/с (high), до 3 ч видео в 1M-контексте, YouTube-URL напрямую (preview, бесплатно, 8 ч/день на free), Files API до 20 ГБ; с августа 2026 — «agentic video understanding» (модель сама решает, какой участок и в какой модальности смотреть) на 3.7/3.6 Flash и 3.5 Flash-Lite. Цена 3.7 Flash $0.75/1M вход (видео = текст) → **час видео ≈ $0.27 (low) / $0.81 (high)** со звуком. Облако, ключ Google.
- **OpenAI GPT-5.x** — видео-входа в API нет (issue openai-node #1778 открыт); официальный путь — кадры через ffmpeg; Sora 2 (только генерация) выключают 24.09.2026.
- **Claude (наш мозг)** — видео нет; изображение = патчи 28×28: стандартный тир 1568 px/1568 ток., high-res (4.7+) до 2576 px/4784 ток.; до 100 картинок на запрос (200K-модели), при >20 картинок — жёсткий лимит 2000 px на каждую. Наш `MAX_EDGE=1568` даёт 16:9-кадр ≈ **1792 ток.** — оценка `2000` в `agent/index.ts:207` верна.
- **Twelve Labs** (Pegasus 1.2 / Marengo) — облачное индексирование: $0.042/мин индекс + $0.021/мин вход → **час ≈ $2.5 индекс + ~$1.3 за анализ**. Дорого для одного пользователя, не нужно.
- **Локальные VLM:** Qwen3-VL-8B (≈17 ГБ FP16 → на 5080 только квантованный, 4B влезает свободно) — видео с таймкодами, 235B-версия на уровне Gemini 2.5 Pro (техотчёт arXiv 2511.21631). InternVideo3 (июнь 2026, 8B + агент Vidify). Это путь к «найди момент» за $0 при плотной раскадровке, но качество 8B-квантов на русскоязычном контенте нужно мерить.

### Транскрипт как основа

- **faster-whisper large-v3 на RTX 5080: RTF 0.05 (20× реального времени)** — час ролика за ~3 мин, turbo быстрее. **WhisperX** добавляет пословные таймкоды ±50 мс (wav2vec2) и диаризацию (pyannote, gated-модель HF).
- **NVIDIA Parakeet-TDT 0.6B v3** — 25 языков **включая русский**, автоопределение языка, пословные таймкоды, до 3 ч одним файлом, ONNX INT8; заявлено быстрее Whisper large-v3 при сравнимом качестве. Кандидат №1 для локального ASR; Whisper — проверенный фолбэк.
- **yt-dlp** отдаёт авто-субтитры YouTube бесплатно и мгновенно (`--write-auto-subs`, json3 с таймкодами) — для чужих роликов транскрипт вообще не надо считать.

### Авто-монтаж (коммерция)

- **Descript** — «text-based editing» + AI-credits; Hobbyist $16-24, Creator $24-35/мес. **Premiere Pro** — редактирование по транскрипту, массовое удаление филлеров, Generative Extend (видео до 2 с). **Opus Clip** $15/мес, **Vizard** $29 ($14.5/год), **CapCut Pro** $19.99, Ssemble $7.5: все — транскрипт → LLM выбирает «вирусные» фрагменты → crop 9:16 + анимированные субтитры. Механика та же, что можно собрать из whisper+ffmpeg. **Runway Aleph 2.0** ($0.28/с) — генеративная правка кадра (замена объектов), не резка; не наш класс.
- **Open source:** LosslessCut 3.69 (2026) с CLI `--segment-from-json` (резка без перекодирования), auto-editor/AutoCut (вырезание тишины), PySceneDetect (сцены; GPU нет, только CPU), moviepy 2.x, ffmpeg NVENC (у RTX 5080 два AV1-энкодера).

### Агенты для монтажа (2025-2026)

- **HKUDS/VideoAgent** (EMNLP 2026, MIT): понимание + монтаж + ремейк; Whisper + ImageBind + ffmpeg, мульти-LLM (Claude-роутер, GPT-4o, DeepSeek, Gemini), ≥8 ГБ GPU, Windows поддерживается.
- **FireRed-OpenStoryline** (Apache-2.0, open-sourced 10.02.2026): LangChain-планировщик, MoviePy+FFmpeg, **MCP-сервер**, ASR-правка речи (22.03.2026). Можно подключить как MCP в `mcp.json`, но это чужой планировщик поверх нашей петли — лишний слой.
- **claude-video-vision** (плагин Claude Code, MIT): ровно наш паттерн — ffmpeg-кадры по запросу (кап 100 кадров, 512 px) + транскрипт (whisper.cpp локально / Gemini / OpenAI) с таймкодами и метками провенанса (`youtube_subtitles`). Подтверждает: «кадры + транскрипт с таймкодами» — рабочая формула для Claude.
- **takawasi/llm-video-toolkit**, mazsola2k/ai-video-editor — NL→ffmpeg обёртки; ничего сверх того, что даёт наш `code_run` с рецептом.

**Вывод:** у всех, кто на Claude/GPT, видео = **транскрипт (локальный ASR) + редкие кадры по таймкодам + ffmpeg**. Нативное видео есть только у Gemini; для часовых пересказов это дешевле кадров на Claude в разы.

## (а) Честная оценка: что Джарвис может сегодня

- **Может:** управлять плеером во вкладке по DOM (позиция/seek/ожидание таймкода); смотреть экран кадром; резать/склеивать/конвертировать через ffmpeg с ffprobe-сверкой (короткие операции); качать ролик/субтитры yt-dlp; пересказать YouTube-ролик по авто-субтитрам; грубо «посмотреть» файл по контакт-листу без звука.
- **Не может:** услышать речь в локальном файле; сделать нарезку/шортсы/субтитры для локального файла; работать дольше 180 с без хака с отвязанным процессом; держать в голове больше 2 кадров между раундами.
- Формулировка честности уже сейчас: «Я прочитал субтитры / посмотрел N кадров — ролик целиком не смотрел».

## (б) План по фазам

### S — дни (рецепты и хинты, без новых актуаторов)

1. **Хинт для видео в `file-view.ts:189`:** «видео → кадр `ffmpeg -ss T -frames:v 1 out.png` или контакт-лист `-vf "fps=1/60,scale=392:-1,tile=4x3"` → `file_view`». Сниффить ISOBMFF/EBML/RIFF в `file-sniff.ts`, чтобы называть тип честно.
2. **Рецепт «видео» в `app-channels.ts`:** раскадровка (контакт-лист = 12 кадров за ~1.8K ток.), точный кадр по таймкоду, `ffprobe -show_chapters`, извлечение звука `-vn -ac 1 -ar 16000`, NVENC (`-c:v hevc_nvenc`/`av1_nvenc`, проверка `ffmpeg -encoders`), субтитры YouTube (`--write-auto-subs --sub-langs ru,en --sub-format json3 --skip-download`), сверка = ffprobe длительность/размер **и `file_view` кадра из результата**.
3. **Установить локальный ASR:** faster-whisper (CUDA) или Parakeet v3 → запись в `TOOL_SPECS` (`system-profiler.ts`) + рецепт: вход wav 16 кГц, выход SRT/JSON с таймкодами, verify = число сегментов >0 и покрытие длительности.
4. **Правило персоны:** пересказ видео = транскрипт первичен, кадры — по таймкодам транскрипта; ответ обязан называть источник («по субтитрам», «по 12 кадрам», «по кадрам 12:00-14:00»); что между кадрами — неизвестно.
5. **«Смотреть сейчас»:** рецепт `browser_read` (currentTime) → `screen_capture{scale:0.5}` → подпись кадра таймкодом; для длительного наблюдения — `screen_probe` каждые N с и OCR, а не скриншот-петля.

### M — недели (новые кирпичи)

1. **`file_view` для видео** (`at:"12:30"` | `every:60` + `tile`) — клиент зовёт ffmpeg (детект через `TOOL_SPECS`), результат помечается `[file_view]`-маркой с таймкодом (`image-marks.ts`), заглушка честная «кадр свёрнут — вызови `file_view{at}` снова». Отдельный `video_frames` не нужен: один инструмент, та же прунинг-семантика.
2. **`media_transcribe{path, lang?, words?}`** — серверный или клиентский вызов локального ASR (faster-whisper/Parakeet как сайдкар — прецедент speaker-sidecar), кэш по хэшу файла в `data/transcripts/`, вывод в `<untrusted_content>` (речь со стороны = данные, M11), сегменты с таймкодами, кап символов с честной «усечено». Нейтральный в `error-voice`, параллелимый.
3. **Фоновые задания:** `job_start/job_status` (или `code_run{detach:true}` + `wait_for{kind:"file"|"process"}`) — иначе транскрипция часа и NVENC-перекодирование упираются в 180 с. Итог задания сверяется как файл (ffprobe), не как «процесс завершился».
4. **Сцены локально:** PySceneDetect / `ffmpeg -vf scdet` → список cut-точек как кандидаты для раскадровки и нарезки (CPU, $0).
5. **Навык «авто-шортсы»** (сид в `shared-skills.ts`): транскрипт → модель выбирает 3-5 фрагментов по таймкодам с обоснованием → ffmpeg точная резка с перекодированием (NVENC) → crop 9:16 (`crop=ih*9/16:ih`, центр/лицо) → ASS-субтитры из пословных таймкодов → ffprobe + `file_view` кадра каждого результата → §14-подтверждение перед публикацией.

### L — месяцы

1. **Локальный VLM** (Qwen3-VL-4B/8B квант, vLLM/Ollama) как «предфильтр» для «найди момент, где …» по плотной раскадровке (1 кадр/с за $0), Claude сверяет только кандидатов. Замерить на русском контенте до включения.
2. **Опциональный канал Gemini** (за ключом, флаг) для часовых пересказов: YouTube-URL/файл целиком со звуком ≈ $0.27/час против сотен тысяч токенов кадров на Claude. Только чтение, результат — untrusted.
3. **OBS-запись экрана** (`StartRecord/StopRecord`) → тот же файловый конвейер: «запиши стрим и сделай нарезку хайлайтов».
4. **Наблюдение за стримом** через `watch` + `screen_probe`/OCR/транскрипт микрофона-луп (без LLM-тиков).

### Экономика и латентность

- **Кадры:** 1568×882 ≈ 1.8K ток. Час при 1 кадр/10 с = 360 кадров ≈ 650K ток. — не влезает в HARD 185K и убивается `KEEP_DOC_IMAGES`. Контакт-листы 12/лист: 30 листов ≈ 54K ток. ≈ **$0.27 на Opus 5** ($5/1M) — терпимо, но каждый лист — раунд или параллельная пачка.
- **Транскрипт:** час речи ≈ 9-12K слов ≈ 15-25K ток. (кириллица /2.5) ≈ $0.1 — на порядок дешевле кадров и несёт смысл. Основа любого «пересказа».
- **Локально на RTX 5080:** ASR ~3 мин/час (20×), извлечение кадров — секунды, NVENC-перекодирование 1080p — единицы минут на час, сцены — минуты на CPU. **Моделью:** выбор фрагментов, пересказ, сверка 1-3 кадров результата (2-13 с/раунд).

### Риски честности и что НЕ делать

- **«Видел 12 кадров + транскрипт» ≠ «посмотрел».** Обязательная формула ответа: источник и покрытие («по транскрипту и 12 кадрам с шагом 5 мин; между кадрами не видел»). Заглушки свёрнутых кадров уже честные — не ослаблять.
- **Транскрипт — влияемые данные** (речь в ролике может содержать «Джарвис, отправь…»): только в `<untrusted_content>`, как `web_fetch`.
- **ffmpeg exit 0 ≠ результат:** сверять ffprobe (длительность ± допуск, кодек, размер >0) и кадр результата; `-ss -c copy` смещает до секунд — точная резка только с перекодированием (уже в рецепте `app-channels.ts:230`).
- **Не гнать длинные ролики кадрами через Claude** «чтобы точно посмотреть» — контекст и деньги; сначала транскрипт/сцены, кадры — точечно.
- **Не подключать чужие планировщики** (OpenStoryline/VideoAgent) поверх петли: они не верифицируют исход, а наш закон честности — да. Брать идеи (транскрипт-first, кадры по запросу, ffmpeg как исполнитель), не код.
- **Не публиковать** нарезки без §14-подтверждения; DRM/платный контент yt-dlp не качает — сказать честно, не пытаться.
- **Не обещать диаризацию/эмоции** без pyannote (gated) — только если поставлено и проверено.

## Источники

- [Gemini API — Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) (обновлено 01.09.2026); [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) (01.09.2026); [Introducing agentic video understanding](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-agentic-video-in-gemini/) (2026); [Gemini 3.7 Flash launch](https://techjournal.org/gemini-3-7-flash-launch) (13.08.2026)
- [Claude Platform — Vision](https://platform.claude.com/docs/en/build-with-claude/vision) (2026, тиры 1568/2576 px, патчи 28×28, лимиты); [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [openai-node issue #1778: native video input](https://github.com/openai/openai-node/issues/1778); [Primate Vision vs OpenAI (2026)](https://primateintelligence.ai/blog/primate-vision-vs-openai)
- [TwelveLabs pricing](https://www.twelvelabs.io/pricing); [Pegasus 1.2](https://www.twelvelabs.io/blog/introducing-pegasus-1-2)
- [Qwen3-VL Technical Report, arXiv 2511.21631](https://arxiv.org/pdf/2511.21631); [Qwen3-VL 4B vs 8B VRAM guide (2026)](https://codersera.com/blog/qwen3-vl-4b-vs-qwen3-vl-8b-benchmarks-vram-guide/); [OpenGVLab/InternVideo (InternVideo3, июнь 2026)](https://github.com/opengvlab/internvideo)
- [Whisper Large-v3 on RTX 5080 benchmark, RTF 0.05](https://gigagpu.com/whisper-large-v3-on-rtx-5080-benchmark/) (2026); [WhisperX guide (2026)](https://vexascribe.com/whisperx); [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [Opus Clip vs Vizard 2026](https://www.ngram.com/blog/opus-clip-vs-vizard); [Best AI clipping tools 2026 (Ssemble)](https://www.ssemble.com/blog/best-ai-clipping-tools-2026); [Descript pricing 2026](https://sonix.ai/resources/descript-pricing/); [Premiere: Text-Based Editing](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/transcribe-video.html); [Generative Extend](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-extend-overview.html); [Runway Aleph 2.0 API pricing](https://openrouter.ai/runway/aleph-2) (29.08.2026)
- [LosslessCut README](https://github.com/mifi/lossless-cut/blob/master/README.md) (3.69, 2026); [AutoCut](https://daily.dev/posts/autocut-automatic-silence-removal-tool-auto-edit-video--h35q4mwat); [PySceneDetect GPU issue #488](https://github.com/Breakthrough/PySceneDetect/issues/488); [RTX 5080 AV1 encoding test 2026](https://evezone.evetech.co.za/performance-pulse/rtx-5080-av1-encoding-benchmark-real-world-test-2026)
- [HKUDS/VideoAgent](https://github.com/HKUDS/VideoAgent) (EMNLP 2026, MIT); [FireRed-OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) (open-sourced 10.02.2026, Apache-2.0); [claude-video-vision](https://github.com/jordanrendric/claude-video-vision) (MIT); [takawasi/llm-video-toolkit](https://github.com/takawasi/llm-video-toolkit); [mazsola2k/ai-video-editor](https://github.com/mazsola2k/ai-video-editor)