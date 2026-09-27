# Jarvis — карта проекта (читать в начале сессии)

> **Карта, а не летопись**: ЧТО/ГДЕ/КАК и законы, файл ≤ 20 КБ. История и «почему» —
> [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (grep по имени механизма); механика и тестирование —
> [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md); план и вердикт — [`docs/REVIEW_2026-09-26.md`](docs/REVIEW_2026-09-26.md).
> Меняешь архитектуру — одна-две строки сюда, абзац — в конец CHANGELOG.

## Что это
Голосовой ассистент-мажордом «Джарвис» для ОДНОГО владельца на его Windows-ПК: слышит → понимает → управляет
компьютером → отвечает голосом, сам напоминает/следит/докладывает. pnpm-монорепо, Node ≥ 20, pnpm 9.
Мозг — Claude по **подписке Max через Agent SDK** (сессия SDK на задачу; API по ключу выключен с 31.08): модель
Opus 5, тир задаёт эффорт (medium/high/max); на API тиры Sonnet → Opus (§7). TTS Yandex (filipp), STT Deepgram
nova-3, слух — локальный sherpa KWS + Silero VAD (W1).

## Законы (нарушение = дефект, даже если тесты зелёные)
1. **Честность исхода.** Инструмент НИКОГДА не рапортует ложный успех; провал → «не вышло», неизвестно → «не знаю,
   ушло ли». У отправки ТРИ исхода (ушло / не ушло / неизвестно): `ToolResult.sent` / `declined` / `uncertain`.
   Сигнал честности обязан дойти до ВСЕХ потребителей (петля, журнал чекпойнта, метрики, самообучение).
2. **Не хардкодить сценарии.** Даём сильные честные инструменты; модель сама ими пользуется. Знание о программах —
   данные (навыки, рецепты каналов), не код.
3. **SRP, модули < 150 строк, общие компоненты, DRY.** Новый модуль длиннее — повод разбить.
4. **НЕ чат-бот**: голос — узкий канал; ответ коротко, первым делом делом.
5. **Безопасность периметра**: loopback fail-closed, `/ext` — пиннинг по key, SSRF (`shared/private-host.ts`) и навигации, `<untrusted_content>` вокруг всего,
   что читается извне (страницы, OCR, файлы, MCP, заголовки окон), §14-подтверждение необратимого (отправка людям,
   удаление, оплата), рельсы самоправки. `code_run` намеренно мощный (не песочница) — политика владельца.

## Процесс (обязательно)
- **Тест ценен, только если ПАДАЕТ на сломанной реализации** — реверт-проверка (сломай охраняемое → тест упал).
  Гард — поведением, не грепом по исходнику. Проводку между механизмами — ПЕТЛЁЙ (`handleUserText`), не чистой функцией.
- **Живой смоук обязателен** для звука, GUI, расширения: «тесты зелёные, живьём не проверено» ≠ «сделано».
  Сам тестирую текстом (`_jarvis_cmd.mjs`), владельца голосом не прошу.
- **Агенты**: ≤ 3 на воркфлоу, ≤ 2 раунда ревью (лимит подписки общий). Инкремент: ревью → PR → merge.
- **Один флаг — одно решение**: новый `JARVIS_*` только с удалением старого (их ~270, цель < 100).
- Реверт-мутации — только из сохранённой копии, НИКОГДА `git checkout/stash` на рабочем дереве.

## Запуск / тесты
- **Боевой запуск — супервизор**: задача Windows `JarvisSupervisor` (при входе) → `node infra/supervisor.mjs` держит
  сервер (рестарт, /healthz-watchdog, голосовой доклад о падениях) и КЛИЕНТ (`infra/client-keeper.mjs`: упал →
  перезапуск; «Выйти» из трея → маркер до следующего входа). Регистрация: `infra/register-autostart.ps1`.
- Сервер руками: `apps/server` → `npx tsx src/index.ts` (порт **8787**; НЕ `tsx watch`). Логи: `apps/server/data/logs/
  server-YYYY-MM-DD.log` (JSONL), `metrics.jsonl`, `server.out.log`.
- Клиент руками: `apps/client` → `node scripts/build.mjs` → `pnpm start`. Лог: `%APPDATA%/@jarvis/client/logs/`,
  под супервизором — `apps/client/client.{out,err}.log`. Electron из песочницы агента падает на GPU.
- Драйверы: `node _jarvis_cmd.mjs "реплика"` (текст), `node _jarvis_voice.mjs "фраза"` (голос);
  dev-сессия, действия клиента — фейк. Dev-HTTP (`/dev/*`, `/ext/*`) — только при `JARVIS_DEV_HTTP=1`.
- Тесты: `apps/server` `npx vitest run` (~3510), `apps/client` (~1000), `packages/*`, `node --test infra/client-keeper.test.mjs`,
  стенд расширения `node --test "apps/extension/test/*.test.mjs"` (~230, настоящий Chromium; `CHROME_PATH`). Typecheck:
  `pnpm -r typecheck`. Линтера нет. Мутации петли: `scripts/mutate-loop.cjs`, длины функций: `scripts/fn-lengths.mjs`.
- **Стенд (облако, `infra/bench/README.md`)**: `node infra/bench/bench.mjs up|status|tool|say|shot|log|down` — сервер,
  Chromium+расширение на Xvfb, HTTPS-фикстуры на хостах §14; сценарии `node --test "infra/bench/scenarios/*.test.mjs"`.
- БД: нативный PostgreSQL 18 + pgvector (`DATABASE_URL`), миграции `node infra/migrate.mjs` (продуктовые — `--product`).
  Фолбэк PGlite. Docker не используется.
- Модели (ASCII-путь!): `~/.jarvis/models` — слух (`fetch-hearing-models.mjs`), e5 в `hf/` (качается сам с `HF_ENDPOINT`).

## Монорепо (pnpm workspace = `packages/*` + `apps/server` + `apps/client`)
- `packages/protocol` — контракт server↔client (`ActionCommand`/`ActionResult`, сообщения WS).
- `packages/tools` — ВСЕ схемы инструментов LLM; `COLD_TOOL_NAMES` (подгрузка `tool_load`), фасады `look/window/audio`,
  `HOT_TOOL_CEILING` (60). Новый инструмент — схема здесь + хендлер на сервере (+ актуатор на клиенте).
- `packages/shared` — логгер (+ file-sink), `AsyncMutex`/`Semaphore`, `name-match` (тёзки/транслит), модели и цены, commit-risk.
- `packages/userbots` — Telegram (GramJS) / VK отправители.
- `apps/extension` — Chrome MV3 (руки во вкладках; `page/*.js` — page-функции, их гоняет и невидимый
  браузер; сборка — `build.mjs`; после правок — reload + смоук). `apps/sidecar-win` — C# (UIA, OCR, окна, ввод). `apps/mobile` — скелет.

## Сервер (`apps/server/src`)
- `gateway/` — `server.ts` (boot, провайдеры), `router-ws.ts` (сессия: пайплайн, agentDeps, dispatch кадров),
  `session.ts` (sendAction fail-fast, requestConfirm с исходами), `task-control.ts` (стоп/пауза/«вырубись»/killswitch),
  `ws-routes.ts` (`/ws` клиент, `/ext` расширение с пиннингом `JARVIS_EXT_ID`), `dev-session.ts`.
- `brain/agent/` — ядро. `index.ts`: `handleUserText` = голова + `turn-intercepts.ts` (имя, «не тебе», режим, эмоция,
  steer/дубль активной задачи, рефлексы памяти/обязательств, уточнение, эхо-гейт, «доделай») → tier0 → кэш ответов →
  sync-first/фон. `loop/` — фазы: state, context, step, model-call, text-turn + nudge-policy (анти-капитуляция,
  verify-нудж, goal-check), tool-round + tool-classify, post-round (§7, anti-runaway, `family-count`), outcome,
  terminal, finalize. Рядом: `checkpoint*.ts` (журнал прерванной задачи), `mask-observations.ts`, `prune-images.ts`,
  `error-voice.ts` (эффекты: mutate/verify/neutral, BLIND_MUTATE, OUTBOUND_SEND_TOOLS).
- `brain/router/` — tier0 ($0: медиа, громкость, запуск, консьерж), вопрос vs действие, тир (рассуждение/биржа → fable).
- `brain/tools/` — `dispatch.ts` (тонкий маршрутизатор) + `handlers/*` (browser, messaging, info, skills, code, act,
  self, selection, file-view, mail…), `commit-gate.ts` (§14 необратимых кликов), `hot-promotions.ts`, `dynamic.ts`.
- `brain/persona/persona.md` — системный промпт (v91, бампать version при правке), `modes.ts`, `emotion.ts`.
- `brain/tasks/` — реестр задач §20 (durable `data/tasks.json`), scope (правка vs новая), control, narrate.
- `brain/` ещё: `app-channels.ts` (каналы программ + частота W4.2), `capabilities.ts` (паспорт возможностей),
  `profile.ts`, `consent.ts`, `response-cache.ts`, `knowledge/`, `trading/`, `mcp/`.
- `memory/` — episodic (pgvector, порог 0.82), working (окно диалога), user-memory (факты + провенанс), skills (recall,
  гард полярности, скан; общая библиотека — `seed/shared-skills.ts`), site-recipes, resolution-memory.
- `integrations/` — `anthropic.ts`, `fallback-llm.ts`, `subscription-{llm,session}.ts`, `deepgram.ts`,
  `yandex-tts.ts`, `local-embeddings.ts` (e5), `web.ts`, `smtp.ts`/`imap.ts`.
- `voice/pipeline.ts` — машина голоса: wake-гейт, окно разговора (только ответ владельцу), barge-in, `speakQueued`.
- `proactive/` — reminders (серии), watch (наблюдения с действием), ambient (почта/календарь/телеграм из вкладок),
  briefing, consolidation (сон-цикл), incidents, quiet-hours, self-review. `autonomy/` — killswitch, часовой предохранитель.
- `self/` — самоулучшение (свой код, слабости из телеметрии, `self_patch` через ветку+verify).
- `product/` — продуктовый каркас (аккаунты/тарифы/оплата) за `JARVIS_PRODUCT_MODE` (деф 0).
- `obs/` — file-log, metrics (COGS, round, mouth_to_ear, first_answer), pricing.

## Клиент (`apps/client/main`)
- `index.ts` (bootstrap, трей, single-instance, IPC), `transport/` (WS, resume), `owner-quit.ts` (маркер «Выйти»).
- `actuators/` — `dispatch` + apps/input/ground/fs/system/office/screen/browser/code-runner (+ jarvis SDK, `act-bridge.ts`),
  **`act*.ts`** (найди+сделай+сверь: UIA → OCR окна → точка; met/failed/unchecked), **`inject.ts`** (рубеж инжекции),
  `windows-builtins.ts` (встроенные — из %SystemRoot%), `paste-text.ts`, `observe.ts`, `self-guard.ts`.
- `audio/` + `hearing/` + `vad/` + `wakeword/` — слух (см. механизмы). `renderer/` — UI (орб, чат, настройки, память).
- `sensors/` — снимок ПК, профиль системы и каталог автоматизации (`TOOL_SPECS`), `usage-profile.ts` (минуты фокуса).
- `selection/` — режим выделения (рамка «вот тут»), `veil-policy.ts`. `skill-runner/` — реплей навыков.

## Ключевые механизмы (одной строкой; подробности — grep в CHANGELOG)
- **§7 каскад**: Sonnet → Opus при провалах/качестве; `strongLocked`; executor-ступень вниз.
- **§15 кеш и арсенал**: горячие схемы в `tools[]`, холодные — строкой в кешируемом блоке, `tool_load`; MCP — холодные.
- **§20 задачи**: фон с чипом прогресса, аренда ввода для GUI (сериализация), правка на ходу (steer), дубль-гейт,
  очередь GUI-задач, «доделай» по журналу чекпойнта (обещаем слово «доделай»).
- **Verify-долг**: после слепого действия (клик/ввод/act unchecked) финал без сверки глазами → нудж; `observed` снимает долг.
- **Лестница восприятия**: `look` (UIA/OCR/окна) → `browser_read/inspect` → `screen_capture` последним.
- **Проактив**: одна очередь озвучки на всех, retriable-реплики помечаются доставленными только по факту звука.
- **Режим выделения**: `screen_selection{view}` — всегда свежий кадр рамки; под вуалью ввод гейтится `overlay_drawing`.
- **Подписка**: MCP-хендлер SDK ждёт результат НАШЕЙ петли; эффорт — по тиру; thinking всегда adaptive;
  до `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` только персона (кеш CLI между задачами); `persistSession:false`.
- **Ход голосом (24.09)**: промоушен в фон по первому tool_use (`sync-promote.ts`); «заткнись»/«тишина»/«вырубись»/
  голое «хватит» — разные действия (`tasks/control.ts`); подсказка навыка — raw ≥ 0.86.
- **Dev-сессия изолирована** (`AgentDeps.devSession`): своя память и задачи, без самообучения и записи памяти/навыков.
- **Рубеж инжекции (W2)**: все мутации сайдкара — через `inject.ts`: self → §0 → §14 по НАЙДЕННОМУ элементу и
  РЕАЛЬНОМУ процессу (allowlist'ы — `@jarvis/shared`); «да» = гранты области серверной команды (вопрос и ОДИН повтор —
  `send-approved.ts`); мост/реплей/UI без одобрения → отказ. Enter/`\n` в мессенджере/банке/1С — вопрос до буквы.
- **Кадры вместо lastMapping (W2)**: x/y модели — в кадре задачи (сервер `frame-memory.ts`, клиент `frames.ts`);
  лупа — свежий снимок со своим frame; без кадра — честный отказ. `act{steps}` — серия со стопом, шаг = dispatchTool.
- **Браузерные руки (W1, 26.09)**: один ref-режим; `browser_inspect{query}` = find; `browser_act` + set/key/hover/scroll_to;
  горячий `browser_batch` (стоп на uncertain/navigated/submitted); `browser_read{view:image}` — снимок/зум вкладки.
  §14: место — по живой вкладке (`web-place.ts`), LMS — по пути; гард страницы на ЛЮБОМ сайте (Enter/Space на
  кнопко-подобных, set, все submit формы); одобрение — `approvedRef` или видимая подпись (один вопрос); клавиши —
  `shared/key-combo.ts` = `parseCombo` расширения (стык: `extension/test/fixtures/key-combos.json`); цель вкладки — по задаче.
- **Слух (клиент)**: гейт закрыт между ходами, «Джарвис» локально → пре-ролл 0,9 с; посреди речи не закрывается
  (`gate-closer.ts`); mute посреди фразы → `speech_cancel`; PTT — Ctrl+Alt+J; микрофон повторяется 1→30 с.

## Решения владельца (не переигрывать)
- Работаем **по подписке**, API не оплачиваем (2026-09-09). Резерв/основной — Claude-only, мульти-провайдер не берём.
- Античит-гард НЕ ставим (риск бана принят владельцем). Умный дом, печать, сканер — не делаем.
- Алерты — голосом Джарвиса + toast, без Telegram-бота. Пульт — нативный Android + свой relay. Инсталлер — делаем.
- GUI-протоколы — ПОКАЗОМ и быстро: Dota 2 (меню), Discord, OBS, Telegram Desktop (веб-Telegram не открывать);
  частые программы Джарвис выводит сам (W4.2).
- Продуктовый каркас — только за мастер-флагом; дефолт = сегодняшний режим владельца.

## Грабли (проверено болью)
- `.env` грузится ПОСЛЕ ESM-хойстинга → env читать в момент вызова; новые сторы — через `lazyDataPath()`.
- Кириллица в путях ломает sherpa/часть утилит → ASCII-пути. `.ps1` — только ASCII.
- Кеши моделей НЕ в `node_modules` (`pnpm install --force` их молча сносит).
- Git worktree с junction на `node_modules`: никогда `git worktree remove --force` без снятия ссылок (сносит `packages/`).
- Распакованное расширение: ID стабилен (`key`), но Chrome помнит ПУТЬ — переезд папки = молча удалено (24.09).
- «Пауза» = медиа-ПЕРЕКЛЮЧАТЕЛЬ: жать только если звук реально идёт (WASAPI peak), иначе включит музыку.
- Opus: не слать temperature/top_p; thinking только `adaptive`; пустые thinking-блоки не реплеить.
- sherpa и onnxruntime (e5) в одном процессе конфликтуют → диктор в сайдкаре, на клиенте только sherpa.
- Chrome 136+ игнорирует CDP на дефолтном профиле → руки в вкладках только через расширение.
- tier0 только серверный (клиентский убран 26.09): фраза-инструкция — модели; `not_found` запуска → откат в модель.
- Синтетический Enter не жмёт нативную кнопку/ссылку/галочку → клик расширения по ним — pointer (H19).
- Денилисты неполны → позитивные allowlist'ы; исключение «рядом хорошее слово» — ключ атакующему.
- Свежий фикс — главный источник следующего дефекта: контроль обязателен.
- Фикстура теста = реальная форма входа (гейт читал `key`, схема шлёт `combo` — тесты молчали).
- Строка прозы навыка, начинающаяся с имени шага (`verify`/`wait`/`launch`), становится шагом слепого реплея.

## Где искать
- План и вердикты: `docs/REVIEW_2026-09-26.md`, `docs/W2_PLAN_2026-09-26.md`, `docs/NEXT_SESSION.md`. Ещё в `docs/`:
  ARCHITECTURE, SECURITY, USER_SCENARIOS_2026-09-02, GUI_MANUALS_RESEARCH_2026-09-05, PRODUCT_FRAMEWORK_PLAN_2026-09-02.
