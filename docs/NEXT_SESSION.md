# Следующая сессия — хендофф

> Состояние на конец сессии 2026-06-15 (поздний вечер). Архитектурные принципы и грабли —
> в памяти: `project_jarvis_architecture.md` (читать ПЕРВЫМ), `feedback_universal.md`,
> `project_jarvis_handoff.md`, `project_jarvis_infra.md` — грузятся автоматически.

## СДЕЛАНО: петля HERMES (самообучение навыками-процедурами) — РАБОТАЕТ, 296 тестов

Корневой принцип пользователя: **НЕ хардкодить под каждый сервис** — ОДИН самообучающийся
агент, который ошибается вначале, но каждый успешный сложный приём сохраняет НАВЫКОМ и
переиспользует (эталон — HERMES от Nous Research). НАВЫК = процедура-памятка, которой LLM
СЛЕДУЕТ гибко, **НЕ реплей кликов**. Все 5 пунктов одобренного плана реализованы:

1. **`skill_save` (новый server-side инструмент)** — схема `packages/tools/src/index.ts`
   (`SKILL_TOOLS`: `{name, when, procedure}`); хендлер `brain/tools/dispatch.ts` (`skillSave`).
   Хранение: `memory/skills.ts` `createSkillProvider().save()` → `content_md` = фронтматтер
   (`source: learned`, name, version, `description`=when) + тело-процедура; БД-upsert (`saveSkill`)
   + осязаемый файл `data/skills/<id>.md` (общий `writeSkillFile`). Повторное сохранение того же
   имени → version++ (улучшение, п.5). `slugify`/`writeSkillFile` вынесены в `skills.ts` (DRY —
   `brain/skills/record.ts` теперь их переиспользует).
2. **RECALL в начале задачи** — `runAgentLoop` зовёт `deps.skills.recall(userId, text)` ПОД
   ТАЙМАУТОМ (как facts), лексический матч с грубым стеммингом (`matchLearnedSkill`, чистая
   функция, порог ≥2 попаданий и ≥1/3 перекрытие — ложный recall вреднее пропуска). Найденный
   навык форматируется (`formatRecalledSkill`) и вшивается через новое поле
   `UserContextSlot.learnedSkill` → `buildSystemPrompt` отдельным блоком «# Подходящий выученный
   навык» (руководство, не факт; модель вольна игнорировать, если не подходит).
3. **AUTO-SAVE бэкстоп** — после успешной задачи (`!failed && !limited && !cancelled && finalText
   && round>=3 && !recalled && !skillSavedInLoop && deps.skills`) `selfLearnSkill` гонит ≤4 узких
   ходов (набор ТОЛЬКО `skill_save`/`skill_list` — рефлексия не делает реальных действий) с
   траекторией инструментов (`toolTrajectory`) в нудже. Ошибки глушатся, голосовой ответ не
   блокируется. `skill_save`, вызванный моделью ПО ХОДУ задачи, выставляет `skillSavedInLoop` →
   повторно не нуждим.
4. **Персона** (`persona.md` §8, version 12→13) — добавлен блок «Навыки — твоя процедурная память
   (`skill_save`)»: сохраняй обобщённо после сложной задачи; в начале похожей следуй показанному
   навыку; разовое не сохраняй.
5. **Разделение реплей- и процедура-навыков** — `createSkillProvider().list/get` ФИЛЬТРУЮТ
   `source: learned` (их нельзя реплеить через `skill_execute`; они только для recall). UI-каталог
   («Навыки») через `listSkills`/`pushSavedSkills` по-прежнему видит всё.

**Тесты (302, было 285):** `skills.test.ts` (serializeLearnedSkill/matchLearnedSkill +
ложные-срабатывания стемминга/порог/тай-брейк, slugify, isLearnedMd, createSkillProvider
save→recall БЕЗ БД с version++), `skill-tools.test.ts` (skill_save: ok/валидация/нет провайдера),
`agent/index.test.ts` (recall вшивает процедуру; бэкстоп сохраняет; провал → НЕ сохраняем; recall
сработал → НЕ навязываем). `pnpm -r typecheck` + `@jarvis/server test` зелёные.

**Пост-ревью хардненг (адверсариальный workflow, 9 подтверждённых → исправлены):**
- **#1 крит:** `pushSavedSkills` (`gateway/router-ws.ts`) слал learned-процедуры в UI как
  РЕПЛЕЙ-карточки (их derived-«шаги» из прозы могли исполниться по клику) → теперь фильтрует
  `isLearnedMd` и ставит `needsReview = hasGuardSteps` (а не хардкод false).
- **#2 крит:** learned и demonstrated навыки делили id-пространство (`slugify(name)`) → upsert
  затирал друг друга. Теперь learned-id с префиксом `learned__` (slugify не порождает `_` →
  коллизия невозможна).
- **#3:** бэкстоп срабатывал и на ПРОВАЛЕ (`finalText` ставится и когда модель сдалась) → добавлен
  гейт `anyToolSucceeded`.
- **#6 (универсальность):** без БД skill_save «учил в пустоту» → in-memory-фолбэк в
  `saveSkill/getSkill/listSkills` (как у эпизодической памяти); version++ работает и без Postgres.
- **#7:** бэкстоп ел бюджет `maxStepsPerTask=30` той же задачи → отдельный метр `${taskId}:reflect`
  (+лог при отказе предохранителя); spendCap/kill-switch по-прежнему действуют.
- **#8/#9:** 4-симв. стемминг recall давал ложные совпадения (стол*/поч*) → длинозависимый порог
  общего префикса `max(5, ⌈0.75·min(len)⌉)` + детерминир. тай-брейк по id.

**ОТЛОЖЕНО (осознанно, на потом):**
- **Клиентский confirm на UI-повтор навыка** (§14): `runSavedSkill` в `apps/client/main/index.ts`
  реплеит guard-навык БЕЗ подтверждения (серверный `skill_execute` — с подтверждением). Это
  ПРЕД-существующая дыра (не про HERMES; learned-процедуры туда уже не попадают). Заведена задача.
- **Улучшение навыка на ОШИБКЕ** recall'нутого (сейчас version++ только при явном пере-`skill_save`).
  Куратор: stale 30д / archive 90д, LLM-доработка.
- **Семантический recall** (сейчас лексический + стемминг; навыки НЕ эмбеддятся) — если навыков
  станет много с синонимичными формулировками, эмбеддить when/name и матчить косинусом.
- **agentskills.io-стандарт** формата — опционально.
- Учитывать `fail_count`/реальное «применил ли модель навык» вместо «recalled != null» как прокси.

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
