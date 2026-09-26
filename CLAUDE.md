# Jarvis — карта проекта (читать в начале сессии)

> **Карта, а не летопись** (§8.3 ревью 09.09): ЧТО/ГДЕ/КАК и законы, файл ≤ 20 КБ. История и «почему» —
> [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (grep по имени механизма); механика и тестирование —
> [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md); план и вердикт — [`docs/REVIEW_2026-09-24.md`](docs/REVIEW_2026-09-24.md).
> Меняешь архитектуру — одна-две строки сюда, абзац — в конец CHANGELOG.

## Что это
Голосовой ИИ-ассистент-мажордом «Джарвис» для ОДНОГО владельца на его Windows-ПК: слышит → понимает → управляет
компьютером инструментами → отвечает голосом, сам напоминает/следит/докладывает. pnpm-монорепо, Node ≥ 20, pnpm 9.
Мозг — Claude по **подписке Max через Agent SDK** (сессия SDK на задачу, W2; API по ключу выключен с 31.08): модель
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
5. **Безопасность периметра**: loopback fail-closed, SSRF-гарды на всех URL-путях, `<untrusted_content>` вокруг всего,
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
  server-YYYY-MM-DD.log` (JSONL), `metrics.jsonl` (task/round/mouth_to_ear/degradation), `server.out.log`.
- Клиент руками: `apps/client` → `node scripts/build.mjs` → `pnpm start`. Лог: `%APPDATA%/@jarvis/client/logs/`,
  под супервизором — `apps/client/client.{out,err}.log`. Electron из песочницы агента падает на GPU — артефакт среды.
- Драйверы: `node _jarvis_cmd.mjs "реплика"` (текст), `node _jarvis_voice.mjs "фраза"` (голос: TTS → кадры → STT);
  dev-сессия, действия клиента — фейк. Dev-HTTP (`/dev/*`, `/ext/*`) — только при `JARVIS_DEV_HTTP=1`.
- Тесты: `apps/server` `npx vitest run` (~3050), `apps/client` `npx vitest run` (~790), `packages/*`, `node --test
  infra/client-keeper.test.mjs`, `node --test "apps/extension/test/*.test.mjs"`. Typecheck: `pnpm -r typecheck`. Линтера нет. Мутационная таблица петли:
  `node apps/server/scripts/mutate-loop.cjs`. Длины функций: `node apps/server/scripts/fn-lengths.mjs`.
- БД: нативный PostgreSQL 18 + pgvector (`DATABASE_URL`), миграции `node infra/migrate.mjs` (продуктовые — `--product`).
  Фолбэк PGlite. Docker не используется.
- Модели (ASCII-путь!): `~/.jarvis/models` — слух (`fetch-hearing-models.mjs`), e5 в `hf/` (качается сам с `HF_ENDPOINT`).

## Монорепо (pnpm workspace = `packages/*` + `apps/server` + `apps/client`)
- `packages/protocol` — контракт server↔client (`ActionCommand`/`ActionResult`, сообщения WS).
- `packages/tools` — ВСЕ схемы инструментов LLM; `COLD_TOOL_NAMES` (подгрузка `tool_load`), фасады `look/window/audio`,
  `HOT_TOOL_CEILING` (60). Новый инструмент — схема здесь + хендлер на сервере (+ актуатор на клиенте).
- `packages/shared` — логгер (+ file-sink), `AsyncMutex`/`Semaphore`, `name-match` (тёзки/транслит), модели и цены, commit-risk.
- `packages/userbots` — Telegram (GramJS) / VK отправители.
- `apps/extension` — Chrome MV3 (руки во вкладках владельца; сборка клиентским `build.mjs`; после правок — reload
  в `chrome://extensions` + смоук). `apps/sidecar-win` — C# (UIA, OCR, окна, ввод). `apps/mobile` — скелет.

## Сервер (`apps/server/src`)
- `gateway/` — `server.ts` (boot, провайдеры), `router-ws.ts` (сессия: пайплайн, agentDeps, dispatch кадров),
  `session.ts` (sendAction fail-fast, requestConfirm с исходами), `task-control.ts` (стоп/пауза/«вырубись»/killswitch),
  `ws-routes.ts` (`/ws` клиент, `/ext` расширение с пиннингом `JARVIS_EXT_ID`), `dev-session.ts`.
- `brain/agent/` — ядро. `index.ts`: `handleUserText` = голова + `turn-intercepts.ts` (имя, «не тебе», режим, эмоция,
  steer/дубль активной задачи, рефлексы памяти/обязательств, уточнение, эхо-гейт, «доделай») → tier0 → кэш ответов →
  sync-first/фон. `loop/` — петля по фазам: `state.ts` (LoopState), `context.ts` (LoopCtx), `step.ts` (раунд),
  `model-call`, `text-turn` + `nudge-policy` (анти-капитуляция, verify-нудж, goal-check), `tool-round` +
  `tool-classify`, `post-round` (эскалация §7, anti-runaway), `outcome.ts` (чистый исход), `terminal.ts` (таблица
  терминалов), `finalize.ts`. Рядом: `checkpoint*.ts` (журнал прерванной задачи), `mask-observations.ts`,
  `prune-images.ts`, `replay-gate.ts`, `thinking-policy.ts`, `error-voice.ts` (эффекты инструментов:
  mutate/verify/neutral, BLIND_MUTATE, OUTBOUND_SEND_TOOLS).
- `brain/router/` — tier0 ($0: медиа, громкость, запуск, консьерж), вопрос vs действие, тир (рассуждение/биржа → fable).
- `brain/tools/` — `dispatch.ts` (тонкий маршрутизатор) + `handlers/*` (browser, messaging, info, skills, code, act,
  self, selection, file-view, mail…), `commit-gate.ts` (§14 необратимых кликов), `hot-promotions.ts`, `dynamic.ts`.
- `brain/persona/persona.md` — системный промпт (v88, бампать version при правке), `modes.ts`, `emotion.ts`.
- `brain/tasks/` — реестр задач §20 (durable `data/tasks.json`), scope (правка vs новая), control, narrate.
- `brain/` ещё: `app-channels.ts` (каналы программ + частота W4.2), `capabilities.ts` (паспорт возможностей),
  `profile.ts`, `consent.ts`, `response-cache.ts`, `knowledge/`, `trading/`, `mcp/`.
- `memory/` — episodic (pgvector, порог 0.82), working (окно диалога), user-memory (факты + провенанс), skills (recall,
  гард полярности, скан; общая библиотека — `seed/shared-skills.ts`), site-recipes, resolution-memory.
- `integrations/` — `anthropic.ts`, `fallback-llm.ts`, `subscription-{llm,session}.ts` (W2), `deepgram.ts`,
  `yandex-tts.ts`, `local-embeddings.ts` (e5), `web.ts`, `smtp.ts`/`imap.ts`.
- `voice/pipeline.ts` — машина голоса: wake-гейт, окно разговора (только ответ владельцу), barge-in, `speakQueued`.
- `proactive/` — reminders (серии), watch (наблюдения с действием), ambient (почта/календарь/телеграм из вкладок),
  briefing, consolidation (сон-цикл), incidents, quiet-hours, self-review. `autonomy/` — killswitch, часовой предохранитель.
- `self/` — самоулучшение (свой код, слабости из телеметрии, `self_patch` через ветку+verify).
- `product/` — продуктовый каркас (аккаунты/тарифы/оплата) за `JARVIS_PRODUCT_MODE` (деф 0).
- `obs/` — file-log, metrics (COGS, round, mouth_to_ear), pricing.

## Клиент (`apps/client/main`)
- `index.ts` (bootstrap, трей, single-instance, IPC), `transport/` (WS, resume), `owner-quit.ts` (маркер «Выйти»).
- `actuators/` — `dispatch` + apps/input/ground/fs/system/office/screen/browser/code-runner (+ jarvis SDK, `act-bridge.ts`),
  **`act*.ts`** (найди+сделай+сверь: UIA → OCR → точка; met/failed/unchecked; type без цели — в фокус), `commit-guard.ts`
  (§14), `windows-builtins.ts` (встроенные программы — из %SystemRoot%), `paste-text.ts`, `observe.ts`, `self-guard.ts`.
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
- **Подписка (W2)**: MCP-хендлер SDK ждёт результат НАШЕЙ петли; эффорт по тиру (haiku medium / sonnet high / fable max);
  thinking всегда adaptive; до `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` только персона (кеш CLI между задачами); `persistSession:false`.
- **Ход голосом (24.09)**: промоушен в фон по первому tool_use (`agent/sync-promote.ts`); реакции — разговор
  (`router/reaction.ts`); «заткнись» / «тишина» / «вырубись» / голое «хватит» — разные действия (`tasks/control.ts`,
  таблица — CHANGELOG 24.09); goal-check — при мутации или заявке «открыл…»; подсказка навыка — при raw ≥ 0.86.
- **Dev-сессия изолирована** (`AgentDeps.devSession`): своя память; задачи `dev` не в истории/на диске и отделены от
  задач владельца (`activeForUser/cancelUser(…, dev)`); без самообучения/memory_write/skill_save/рефлексов.
- **Гейты §0/§14**: act{type|set}, слоты skill_execute — под гардом паролей/карт; Enter и печать с `\n` в мессенджере/
  банке/1С — вопрос владельцу (почта — нет); act-коммит без `commitApproved` (ставит только сервер после «да»)
  клиент сверяет с РЕАЛЬНО сфокусированным процессом; мост и реплей — тот же рубеж (`commit-guard.ts`). Веб: место —
  по живому адресу вкладки, LMS — по пути; клик по селектору/ref досуживает страница (`web-commit-guard.ts`).
- **Слух (клиент)**: гейт закрыт между ходами, «Джарвис» локально → пре-ролл 0,9 с; посреди речи не закрывается
  (`gate-closer.ts`); mute посреди фразы → VAD `speech_cancel` (обрубок не исполняется); PTT — Ctrl+Alt+J (окно
  адресации), кнопка микрофона — только открывает гейт; микрофон повторяется 1→30 с; renderer-guard.

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
- Кеши моделей НЕ в `node_modules` (`pnpm install --force` их сносит — эмбеддер умер молча 24.09).
- Git worktree с junction на `node_modules`: никогда `git worktree remove --force` без снятия ссылок (23.09 снесло `packages/`).
- Распакованное расширение Chrome: ID зависит от пути, если в manifest нет `key` (есть с 24.09 — ID `pjkela…ajd`).
- «Пауза» = медиа-ПЕРЕКЛЮЧАТЕЛЬ: жать только если звук реально идёт (WASAPI peak), иначе он включает музыку.
- Opus: не слать temperature/top_p; thinking только `adaptive`; пустые thinking-блоки не реплеить.
- sherpa и onnxruntime (e5) в одном процессе конфликтуют → диктор в сайдкаре, на клиенте только sherpa.
- Chrome 136+ игнорирует CDP на дефолтном профиле → руки в вкладках только через расширение.
- tier0 только серверный (клиентский убран 26.09): фраза-инструкция — модели; `not_found` запуска → откат в модель.
- Синтетический Enter не жмёт нативную кнопку/ссылку/галочку → клик расширения по ним — pointer (H19).
- Денилисты неполны → позитивные allowlist'ы; исключение «рядом хорошее слово» — ключ для атакующего.
- Свежий фикс — главный источник следующего дефекта (24.09: 3 из 10 находок — в моих же правках): контроль обязателен.
- Фикстура теста = реальная форма входа (гейт читал `key`, схема шлёт `combo` — тесты молчали).
- Строка прозы навыка, начинающаяся с имени шага (`verify`/`wait`/`launch`), становится шагом слепого реплея.

## Где искать
- `docs/ARCHITECTURE.md` (история, механика — ссылки в шапке). План и вердикты: `docs/REVIEW_2026-09-24.md`, `docs/REVIEW_2026-09-09.md`, `docs/NEXT_SESSION.md`.
- `docs/SECURITY.md`, `docs/USER_SCENARIOS_2026-09-02.md`, `docs/GUI_MANUALS_RESEARCH_2026-09-05.md`, `docs/PRODUCT_FRAMEWORK_PLAN_2026-09-02.md`.
