# Jarvis — карта проекта (читать в начале сессии)

> **Карта, а не летопись** (правило §8.3 ревью 2026-09-09, введено 2026-09-24). Здесь — ЧТО/ГДЕ/КАК и законы.
> Почему так сделано, история волн и разборов — [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (бывший CLAUDE.md, 528 КБ,
> искать grep'ом по имени механизма). Механика и тестирование — [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md).
> Текущий план и вердикт — [`docs/REVIEW_2026-09-24.md`](docs/REVIEW_2026-09-24.md) (поверх [`REVIEW_2026-09-09`](docs/REVIEW_2026-09-09.md)).
> Меняешь архитектуру — обнови ЭТУ карту одной-двумя строками, а историю — одним абзацем в конец CHANGELOG.
> Держать файл ≤ 20 КБ.

## Что это
Голосовой ИИ-ассистент-мажордом «Джарвис» для ОДНОГО владельца на его Windows-ПК: слышит → понимает → управляет
компьютером инструментами → отвечает голосом, сам напоминает/следит/докладывает. pnpm-монорепо, Node ≥ 20, pnpm 9.
Мозг — Claude: основной канал Messages API по ключу (кредиты кончились 31.08 → выключен), рабочий — **подписка Max
через Claude Agent SDK** (одна сессия SDK на задачу, W2). Тиры: `haiku`/`sonnet` = Sonnet (слабый), `fable` = Opus
(эскалация §7). TTS — Yandex (голос filipp), STT — Deepgram nova-3, слух — локальный sherpa KWS + Silero VAD (W1).

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
- **Агенты**: ≤ 3 на воркфлоу в сумме (больше — только по числу, названному владельцем), ≤ 2 раунда ревью; лимит
  подписки ОБЩИЙ с мозгом Джарвиса. Каждый инкремент: ревью → PR → merge (делаю сам).
- **Один флаг — одно решение**: новый `JARVIS_*` только с удалением старого (их ~270, цель < 100).
- Реверт-мутации — только из копии строки в памяти, НИКОГДА `git checkout/stash` на рабочем дереве.

## Запуск / тесты
- **Боевой запуск — супервизор**: задача Windows `JarvisSupervisor` (при входе) → `node infra/supervisor.mjs` держит
  сервер (рестарт, /healthz-watchdog, голосовой доклад о падениях) и КЛИЕНТ (`infra/client-keeper.mjs`, с 24.09:
  упал → перезапуск; «Выйти» из трея → маркер, не поднимает до следующего входа). Регистрация: `infra/register-autostart.ps1`.
- Сервер руками: `apps/server` → `npx tsx src/index.ts` (порт **8787**; НЕ `tsx watch`). Логи: `apps/server/data/logs/
  server-YYYY-MM-DD.log` (JSONL), `metrics.jsonl` (task/round/mouth_to_ear/degradation), `server.out.log`.
- Клиент руками: `apps/client` → `node scripts/build.mjs` → `pnpm start`. Лог: `%APPDATA%/@jarvis/client/logs/`,
  вывод под супервизором — `apps/client/client.{out,err}.log`. ⚠️ Из песочницы агента Electron падает на GPU-песочнице
  (артефакт среды агента, не владельца) — для теста `electron . --disable-gpu-sandbox`, проверка «у владельца» — через супервизор.
- Текст-драйвер: `node _jarvis_cmd.mjs "реплика" ...` (dev-сессия; клиентские действия в нём — фейк). `JARVIS_WS_URL`
  для изолированного инстанса. Dev-HTTP (`/dev/*`, `/ext/*`) — только при `JARVIS_DEV_HTTP=1`.
- Тесты: `apps/server` `npx vitest run` (~2890), `apps/client` `npx vitest run` (~715), `packages/*`, `node --test
  infra/client-keeper.test.mjs`. Typecheck: `pnpm -r typecheck`. Линтера нет. Мутационная таблица петли:
  `node apps/server/scripts/mutate-loop.cjs`. Длины функций: `node apps/server/scripts/fn-lengths.mjs`.
- БД: нативный PostgreSQL 18 + pgvector (`DATABASE_URL`), миграции `node infra/migrate.mjs` (продуктовые — `--product`).
  Фолбэк PGlite. Docker не используется.
- Модели на диске (ASCII-путь!): `~/.jarvis/models` — слух (kws, silero, speaker-embedding), эмбеддер e5 (`hf/`).
  Слух ставится `node apps/client/scripts/fetch-hearing-models.mjs`, e5 качается сам с `HF_ENDPOINT`.

## Монорепо (pnpm workspace = `packages/*` + `apps/server` + `apps/client`)
- `packages/protocol` — контракт server↔client (`ActionCommand`/`ActionResult`, сообщения WS).
- `packages/tools` — ВСЕ схемы инструментов LLM; `COLD_TOOL_NAMES` (подгрузка `tool_load`), фасады `look/window/audio`,
  `HOT_TOOL_CEILING` (60). Новый инструмент — схема здесь + хендлер на сервере (+ актуатор на клиенте).
- `packages/shared` — логгер (+ file-sink), `AsyncMutex`/`Semaphore`, `name-match` (тёзки/транслит), модели и цены, commit-risk.
- `packages/userbots` — Telegram (GramJS) / VK отправители.
- `apps/extension` — Chrome MV3 (руки в реальных вкладках владельца; собирается клиентским `build.mjs`; после правок —
  reload в `chrome://extensions` + живой смоук). `apps/sidecar-win` — C# (UIA, OCR, окна, ввод). `apps/mobile` — скелет.

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
- `brain/router/` — tier0 ($0, без LLM: медиа, громкость, запуск, консьерж), вопрос vs действие (`conversational`),
  тир (`looksHardReasoning` → fable, биржа → fable).
- `brain/tools/` — `dispatch.ts` (тонкий маршрутизатор) + `handlers/*` (browser, messaging, info, skills, code, act,
  self, selection, file-view, mail…), `commit-gate.ts` (§14 необратимых кликов), `hot-promotions.ts`, `dynamic.ts`.
- `brain/persona/persona.md` — системный промпт (v86, бампать version при правке), `modes.ts`, `emotion.ts`.
- `brain/tasks/` — реестр задач §20 (durable `data/tasks.json`), scope (правка vs новая), control, narrate.
- `brain/` ещё: `app-channels.ts` (реестр программных каналов + частота программ W4.2), `capabilities.ts` (паспорт
  живых возможностей в промпт), `profile.ts`, `consent.ts`, `response-cache.ts`, `knowledge/`, `trading/`, `mcp/`, `skills/`.
- `memory/` — episodic (pgvector, порог 0.82 под e5), working (окно диалога, durable), user-memory (единый писатель
  фактов + провенанс), skills (+ семантический recall, гард полярности, скан перед записью), site-recipes, resolution-memory.
- `integrations/` — `anthropic.ts` (кеш §15, thinking adaptive), `fallback-llm.ts` (основной ↔ подписка, два класса
  отказа), `subscription-llm.ts` + `subscription-session.ts` (W2: одна SDK-сессия на задачу), `deepgram.ts`,
  `yandex-tts.ts`, `local-embeddings.ts` (e5, кеш `~/.jarvis/models/hf`), `web.ts`, `smtp.ts`/`imap.ts`.
- `voice/pipeline.ts` — машина голоса: wake-гейт (текст + локальный wake), окно разговора (открывает ТОЛЬКО ответ на
  ход владельца, не проактив), barge-in, `speakQueued` (retriable, исход по факту звука), промоушен 1,5 с.
- `proactive/` — reminders (серии), watch (наблюдения с действием), ambient (почта/календарь/телеграм из вкладок),
  briefing, consolidation (сон-цикл), incidents, quiet-hours, self-review. `autonomy/` — killswitch, часовой предохранитель.
- `self/` — самоулучшение (поиск по своему коду, слабости из телеметрии, `self_patch` через ветку+verify).
- `product/` — продуктовый каркас (аккаунты/тарифы/оплата) за `JARVIS_PRODUCT_MODE` (деф 0 = выключен байт-в-байт).
- `obs/` — file-log, metrics (COGS, round, mouth_to_ear), pricing.

## Клиент (`apps/client/main`)
- `index.ts` (bootstrap, трей, single-instance, IPC), `transport/` (WS, resume), `owner-quit.ts` (маркер «Выйти»).
- `actuators/` — `dispatch` + apps/input/ground/fs/system/office/obs/screen/file-view/browser-cdp/jarvis-browser/
  code-runner (+ jarvis SDK через `act-bridge.ts`), **`act*.ts`** (W4: примитив «найди+сделай+сверь» на клиенте:
  UIA → OCR → координаты, вердикт met/failed/unchecked), `commit-guard.ts` (клиентский §14-рубеж), `observe.ts`
  (fused act+observe), `self-guard.ts` (денилист секретов и конфигов прав).
- `audio/` + `hearing/sherpa-hearing.ts` + `vad/` + `wakeword/` — слух W1: гейт закрыт между ходами, «Джарвис»
  локально → пре-ролл 1,5 с + поток в Deepgram. `renderer/` — UI (орб, чат, настройки, память, оплата).
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
  thinking всегда adaptive; до `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` только персона (кеш CLI между задачами).

## Решения владельца (не переигрывать)
- Работаем **по подписке**, API не оплачиваем (2026-09-09). Резерв/основной — Claude-only, мульти-провайдер не берём.
- Античит-гард НЕ ставим (риск бана принят владельцем). Умный дом, печать, сканер — не делаем.
- Алерты — голосом Джарвиса + toast, без Telegram-бота. Пульт — нативный Android + свой relay. Инсталлер — делаем.
- GUI-протоколы — ПОКАЗОМ и быстро; первые приложения: Dota 2 (меню), Discord, OBS, Telegram Desktop (веб-Telegram
  не открывать); частые программы Джарвис выводит сам (W4.2 `usage-profile`).
- Продуктовый каркас — только за мастер-флагом; дефолт = сегодняшний режим владельца.

## Грабли (проверено болью)
- `.env` грузится ПОСЛЕ ESM-хойстинга → env читать в момент вызова; новые сторы — через `lazyDataPath()`.
- Кириллица в путях ломает sherpa/часть утилит → модели и проект в ASCII-путях. `.ps1` — только ASCII.
- Кеши моделей НЕ в `node_modules` (`pnpm install --force` их сносит — эмбеддер умер молча 24.09).
- Git worktree с junction на `node_modules`: никогда `git worktree remove --force` без снятия ссылок (23.09 снесло `packages/`).
- Opus: не слать temperature/top_p; thinking только `adaptive`; пустые thinking-блоки не реплеить.
- sherpa-onnx-node и onnxruntime-node (e5) в одном процессе конфликтуют → на сервере диктор в сайдкаре, на клиенте только sherpa.
- Chrome 136+ игнорирует CDP на дефолтном профиле → руки в реальных вкладках только через расширение.
- tier0 жадный: фраза-инструкция/контент должна уходить модели; `not_found` запуска → откат в модель.
- Денилисты принципиально неполны → позитивные allowlist'ы (smalltalk, «доделай», отказ от предложения).
- Контекстное исключение «рядом хорошее слово» в денилисте — всегда ключ для атакующего.
- Свежий фикс — главный источник следующего дефекта: контрольный проход ревью обязателен.
- Большие bash-команды (> 30 КБ) падают — большие правки через файлы/скрипты в scratchpad.

## Где искать
- История и «почему»: `docs/CHANGELOG.md`. Механика/тестирование: `docs/HOW_IT_WORKS.md`. Архитектура: `docs/ARCHITECTURE.md`.
- План и вердикты: `docs/REVIEW_2026-09-24.md`, `docs/REVIEW_2026-09-09.md`, `docs/NEXT_SESSION.md`.
- Безопасность: `docs/SECURITY.md`. Сценарии по ролям: `docs/USER_SCENARIOS_2026-09-02.md`. GUI-исследование:
  `docs/GUI_MANUALS_RESEARCH_2026-09-05.md`. Продукт: `docs/PRODUCT_FRAMEWORK_PLAN_2026-09-02.md`.
