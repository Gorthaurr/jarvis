# Следующая сессия — хендофф

> Состояние на конец сессии 2026-06-15 (поздний вечер). Архитектурные принципы и грабли —
> в памяти: `project_jarvis_architecture.md` (читать ПЕРВЫМ), `feedback_universal.md`,
> `project_jarvis_handoff.md`, `project_jarvis_infra.md` — грузятся автоматически.

## ГЛАВНАЯ ЗАДАЧА СЛЕДУЮЩЕЙ СЕССИИ: петля HERMES (самообучение навыками)

Пользователь хочет (эмоционально, многократно): **НЕ хардкодить под каждый сервис** (Telegram,
потом YouTube, потом другой мессенджер). Нужен ОДИН общий самообучающийся агент — делает что
угодно общими руками, **ошибается вначале, но каждое успешное действие сохраняет как НАВЫК** и
переиспользует. Эталон — **HERMES** (Nous Research, самый используемый агент по OpenRouter):
после сложной задачи (5+ шагов) сам пишет навык-процедуру в markdown (когда применять + шаги +
грабли + проверка), индексирует, в следующий раз сам находит и СЛЕДУЕТ ему (не жёсткий реплей —
гибко), дорабатывает со временем.

**ПЛАН (одобрен пользователем — procedure-навыки, LLM-followed). 3 шва в
`apps/server/src/brain/agent/index.ts` (`runAgentLoop`):**

1. **`skill_save` (новый инструмент, server-side):** `packages/tools/src/index.ts` (схема) +
   `apps/server/src/brain/tools/dispatch.ts` (хендлер). Агент пишет навык:
   `{ name, when (когда применять), procedure (markdown: шаги + грабли + проверка) }`. Хранить
   через `apps/server/src/memory/skills.ts` — `content_md` = фронтматтер (`source: "learned"`,
   name, description=when) + тело-процедура; `steps: []` (НЕ исполняется детерминированно — навык
   recall'ится КАК ТЕКСТ-руководство). Файл `data/skills/<id>.md` + БД (saveSkill уже upsert'ит).
2. **RECALL в начале задачи** (`runAgentLoop` ~стр.317, рядом с `episodic.search`→facts): найти
   подходящий learned-навык по `text` (семантика через `episodic.search` ИЛИ keyword по
   `skills.list`), вшить его процедуру в системный промпт. Новое поле в
   `apps/server/src/brain/persona/index.ts` `UserContextSlot` (напр. `learnedSkill?: string`) +
   проброс в `buildSystemPrompt`. LLM следует процедуре (адаптируя).
3. **AUTO-SAVE-нудж** после успешной сложной задачи (`runAgentLoop` ~стр.515, после
   `tasks.finish`, при `!failed && !limited && !cancelled && round>=3` и навык НЕ использовался):
   добавить системный нудж «сохрани навык через skill_save» (или правило в персоне). Для контекста
   собирать траекторию: новая переменная `toolExecutionHistory` (`tu.name`+`!r.isError`) в цикле
   исполнения инструментов (~стр.445).
4. **Персона** (`persona.md` §8 «Самостоятельность»): «после успешной многошаговой задачи без
   готового навыка — сохрани через `skill_save`. В начале задачи тебе покажут подходящий навык —
   следуй ему». Уже есть «не сдавайся: исследуй→сделай→напиши инструмент→запомни» — дополнить.
5. **Улучшение навыка:** при переиспользовании/ошибке обновлять (saveSkill upsert, version++).
   Куратор (stale 30д / archive 90д, LLM-доработка) — позже. agentskills.io-стандарт — опционально.

Детальная карта подсистемы (типы/функции/строки) была получена exploration-агентом в этой
сессии — повторить при необходимости. Ключевое: `skills.ts` (parseSkillMd/saveSkill/serializeSkill,
createSkillProvider, hasGuardSteps), `agent/index.ts` (`round`/`convo`/`resp.toolUses`{name,input}/
`r.isError`/эскалация тиров), `episodic.ts` (search по эмбеддингам), `dynamic.ts` (tool_create).
НАВЫК = процедура, которой LLM СЛЕДУЕТ, НЕ реплей кликов. `telegram_send/read` остаются seed-fast-path.

## СДЕЛАНО этой сессией: «Браузер Джарвиса» + Telegram send/read (РАБОТАЕТ)

- **`apps/client/main/actuators/jarvis-browser.ts`** — ТЁПЛЫЙ невидимый Chrome (свой профиль),
  общий слой. ОБЩИЕ примитивы `web_open`/`web_read`/`web_act` (Opus сам читает/действует на ЛЮБОМ
  залогиненном сервисе) + тюнингованные `telegram_send`/`telegram_read`. Это и есть путь к
  «любой мессенджер/YouTube» — НЕ хардкодить, а общими руками + (скоро) навыками.
- Протокол: kinds `telegram.send/telegram.read/jbrowser.open/jbrowser.read/jbrowser.act`
  (`packages/protocol/src/actions.ts`); карта `ACTUATOR_TOOL_BY_KIND` + схемы + тест покрытия
  (`packages/tools`); client `actuators/index.ts` (кейсы); server `dispatch.ts` (telegram_send →
  ActionCommand telegram.send; остальные через generic actuator-путь). Старый `stealth-telegram.ts` удалён.
- **navTo (ВАЖНО, принцип пользователя — не хардкод-матчер):** ищем чат по ПОЛНОЙ строке диалога в
  ВИДИМОМ списке (не глобальный @username-поиск, не угаданный селектор имени); на неоднозначности
  возвращаем `candidates` (полные строки чатов) → НЕЙРОНКА сама выбирает (как человек по скрину) и
  повторяет с точным названием. Saved Messages — через меню по иконке `savedmessages` (язык-независимо).
- **Verified standalone:** send (delivered по исходящему пузырю), read («Катя»→нашёл «Катя Любимая»,
  сообщения с in/out, время/edited вычищены клонированием+удалением meta).
- **Невидимость (универсально):** off-screen позиция = за правым краём ВСЕХ мониторов в ФИЗ.пикселях
  (`scaleFactor`, floor 40000). Причина прошлого «видел браузер» — DIP≠физ при масштабе≠100%.
- Надёжность (из ревью): `AsyncMutex` на ВСЕ операции (не два Chrome на профиль), трекинг
  login-процесса (kill перед тёплым), `proc.on('exit')`, idle-close 5мин, ASCII-профиль (кирилл.
  имя юзера → фолбэк ProgramData).
- Память: добавлены `project_jarvis_architecture.md`, `feedback_universal.md`.
- **Универсальность-ревью (workflow, 31 находка): критичные применены.** ОТЛОЖЕНО: кросс-ОС
  (mac/linux в `chromeCandidates`/`system-profiler` — приложение пока Windows-only); DPI для
  ВИДИМОГО окна `browser-cdp.ts`; авто-параметризация навыков.

## Профиль / логин Telegram
- Профиль браузера Джарвиса: `%LOCALAPPDATA%\JarvisTG\tg-profile` (Telegram УЖЕ залогинен с 2FA).
  Кириллица в пути ломает IndexedDB webK → путь ASCII; вход по НОМЕРУ (QR webK капризен), нужен 2FA-пароль.
- Видимое окно входа: `apps/server/stealth-tg.mjs login` (прототип) или `JarvisBrowser.openLogin()`.
- ОТЛОЖЕНО (прошлая просьба): раздел «Аккаунты» в настройках Electron (кнопки «Войти в Google/…»
  открывают браузер Джарвиса видимо → логин → дальше действует невидимо). Один профиль = все сервисы
  (вошёл в Google → YouTube/почта живые). Делать ПОСЛЕ петли HERMES (она это обобщает).

## Как запускать (durable) / проверять
- **Сервер:** убить процесс на 8787 → `Start-Process cmd.exe "/c", 'cd /d "<repo>\apps\server" && node "<repo>\node_modules\tsx\dist\cli.mjs" src/index.ts > "<repo>\server.log" 2>&1' -WindowStyle Hidden`. PowerShell-вызов СРАЗУ выходит.
- **Клиент:** пересборка `pnpm --filter @jarvis/client build`; запуск `Start-Process electron.exe "." -WorkingDirectory apps\client` (БЕЗ редиректа stdio — иначе GUI не стартует; `-RedirectStandardOutput` для диагностики допустим, но потом stale).
- **Чистый рестарт:** убить 8787-owner + electron + SidecarWin + chrome с `*JarvisTG*` в cmdline; `Start-Sleep 3`; проверить electron=0; старт сервера → healthz → клиент; проверка `server.log` **в UTF-8** (`Get-Content -Encoding UTF8`! иначе кракозябры и ложные «0 хендшейков»): должно быть 1 handshake / 1 сессия, без реконнект-флаппинга (флаппинг = наложение от частых рестартов).
- **Проверки кода:** `pnpm --filter @jarvis/client typecheck` + `@jarvis/server typecheck`; `@jarvis/tools test`; `@jarvis/server test` (был 285); синтаксис PAGE-строки в jarvis-browser.ts: `node -e "new Function(<String.raw содержимое>)"`.
- **ВСЁ НЕЗАКОММИЧЕНО** (вся сессия в рабочем дереве, ветка `feat/native-pg-pgvector-cache-gateway`).

## Чего НЕ делать
- НЕ хардкодить под каждый сервис/кнопку — общие руки + навыки + LLM решает (это корневой принцип).
- НЕ матчить чаты строгими `===` — отдавать кандидатов нейронке.
- НЕ ставить off-screen `-3000`/`+300` — за правым краём всех мониторов в физ.пикселях.
- НЕ MTProto (userbot отвергнут), НЕ расширение для невидимости (Chrome паузит rAF в фон-вкладке).
- НЕ читать server.log без `-Encoding UTF8`. НЕ частить рестартами (флаппинг).
