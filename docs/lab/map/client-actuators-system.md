# Карта: client-actuators-system

Область: `apps/client/main/actuators` (fs, system, office, screen, невидимый браузер, code-runner, obs, messaging, audio-sessions, wait.for) и `apps/client/main/skill-runner`.
Не входит (читают соседние карты): ввод/UIA/act/inject/self-guard/выделение/frames как механизм, окна и app.launch.
Все пути ниже — от `apps/client/main/`. Читалось, ничего не запускалось: живьём НЕ проверено, факты — из кода и тестов.

## 1. Как работает

### Сквозной поток
Сервер шлёт `ActionCommand` по WS -> `transport` -> `dispatch(commandId, cmd)` (`actuators/index.ts:211`) -> `dispatchInner` (`:234`) -> `switch (cmd.kind)` (`:294`, ~60 видов) -> актуатор -> `okResult` / `errResult` -> ровно один `ActionResult` на commandId (контракт §5). Любое исключение -> `error.runtime` (`:779-791`); `ActionError` (`action-error.ts`) несёт свой код (`overlay_drawing`, `denied`, `not_found`) и `stepActionInjected`.

Что делает `dispatchInner` ДО switch:
1. Вуаль режима выделения: физический ввод (`isVeilGatedInput`) при открытом оверлее -> `overlay_drawing` (`:251-260`). Файлы/система/экран этим не гейтятся.
2. USER_BUSY: только для `proactive` и только `PHYSICAL_INPUT_KINDS` (`:265-285`). fs/system/office/code.run не гейтятся.
3. Снимок UIA "до" (`needsBeforeSnapshot`) - только для ввода/`ui.invoke`; к моей области не относится.
После switch `dispatch` (`:211-232`) помечает результат `overlayDrawing:true`, если вуаль была в окне команды (для `wait.for`/`skill.execute` - по решающему опросу).

Серверный таймаут по виду команды - `actionTimeoutMs` (`packages/protocol/src/constants.ts:71-96`); у видов вне списка (`office.*`, `jbrowser.*`, `system.*`, `fs.read/write`, `screen.capture`) - дефолт 15 с.

### Подсистемы
| Подсистема | Файлы | Суть |
|---|---|---|
| Файлы | `fs.ts` (532), `fs-content.ts`, `fs-read-window.ts`, `fs-search-report.ts`, `file-view.ts`, `file-view-pdf.ts`, `file-sniff.ts` | прямые операции над ФС main-процесса; пути через `expandPath`; рельсы `self-guard` (`assertReadable/assertWritable`) |
| Система | `system.ts` | `planSystem` (чистая) + `runSystem` -> `spawn powershell/shutdown/rundll32`; громкость через Core Audio COM с readback |
| Office | `office.ts` | фиксированные PS-скрипты COM Excel/Word, аргументы через temp-JSON в `$env:JARVIS_OFFICE_ARGS`, лок на путь |
| Экран | `screen.ts`, `screen-grab.ts`, `screen-native.ts`, `screen-display.ts`, `screen-ocr*.ts`, `screen-probe.ts`, `sensors-cheap.ts` | `desktopCapturer` в нативе -> кроп/ресайз -> кадр (`frames.ts`, id f/z/s/o); OCR через сайдкар; проба = aHash 8x8 |
| Невидимый браузер | `jarvis-browser.ts` (513), `-act`, `-page`, `-nav-guard`, `-proxy`, `-socks5`, `-proxy-judge`, `cdp-conn.ts`, `browser-cdp.ts` | тёплый Chrome за краем экрана со своим профилем, CDP; SSRF-гард навигации + пиннинг DNS через локальный SOCKS5 |
| Код | `code-runner.ts` (481) | `python -c`/`node -e`/`powershell -Command` без shell; sync с таймаутом или фоновое задание с логами в temp |
| Навыки | `skill-runner/index.ts`, `client-actuator.ts`, `step-policy.ts` | детерминированный реплей шагов без LLM, постусловия auto-wait, ретраи, честные исходы |
| Прочее | `obs.ts`, `messaging.ts`, `audio-sessions.ts`, `wait-file-process.ts` | obs-websocket v5, userbot-отправка, аудио-сессии, ожидание файла/процесса |

### Файлы (`fs.ts`)
- `expandPath` (`:125`): `%VAR%` раскрывается ТОЛЬКО из allowlist (USERPROFILE, APPDATA, TEMP...), `~`, относительный путь - от `homedir()`.
- Чтение: `readFile` (`:167`) режет по `maxBytes` (деф. 2 МБ), сниффит содержимое (бинарник -> ошибка с классом и каналом), декодирует utf8/utf8-bom/utf16/cp1251-по-эвристике; `note`/`truncated`/`totalLines` ставятся ДО `content` (серверный кап режет хвост JSON). Окно строк (`offset/lines/tail`) - `readWindow` (`:224`), для >cap файлов читает голову/хвост кусками.
- Запись: `writeFile` (`:317`, без атомарности, utf8), `editFile` (`:332`, точное совпадение; 0 или >1 без `replaceAll` -> ошибка), `appendFile`, `moveEntry` (rename, EXDEV -> cp+rm), `deleteEntry` (`rm force:false`).
- Рекурсивные delete/move: `assertTreeWritable` (`:35`) - лист + предок запущенного бинаря + скан поддерева до 200 000 записей, исчерпание -> отказ (fail-closed).
- `search` (`:425`): имя или содержимое; ссылки не обходит (считает `skippedLinks`), служебные каталоги (`DEFAULT_IGNORED_DIRS`) не заходит, бюджеты: 20 000 файлов / 40 с / `maxResults` <= 200; ответ всегда несёт `exhausted/stopReason/note` - "не найдено" при `exhausted:false` не значит "нет".
- `viewFile` (`file-view.ts:65`): тип по сигнатуре, stat до чтения, кап 32 МБ, гейт 50 Мп до декодирования; PNG/JPEG ужимаются до `maxSide` (<=1568), GIF/WEBP уходят как есть; PDF - страница через `python -c` + PyMuPDF (`file-view-pdf.ts:56`, таймаут 25 с).

### Система (`system.ts`)
- lock: `rundll32 user32.dll,LockWorkStation`. sleep: `rundll32 powrprof.dll,SetSuspendState 0,1,0`. shutdown/restart - ТОЛЬКО отложенно (`/t N`, N = `JARVIS_SHUTDOWN_DELAY_SEC` 5..600, деф. 25) с текстом предупреждения; `cancel` = `shutdown /a` (терпит ненулевой код); logoff = `shutdown /l` мгновенно.
- media: клавиши через `keybd_event` (VK фикс.); `state` = WASAPI peak 5 замеров за ~300 мс -> `{playing, peak}`; `pause` сначала спрашивает `state` и НЕ жмёт переключатель в тишине (`pauseKeyNeeded`, порог 0.001) - иначе "стоп" запускал бы музыку.
- volume: Core Audio COM (get/set/up/down +-10%/mute) с обратным чтением; `set` сверяет факт с просьбой (допуск 3) и бросает при расхождении. Пауза 150 мс перед readback (асинхронное применение).
- clipboard: `Get-Clipboard -Raw` / `Set-Clipboard $env:JARVIS_CLIP` (текст мимо командной строки); НЕ через electron `clipboard`.
- layout: Win32 `LoadKeyboardLayout` + `WM_INPUTLANGCHANGEREQUEST` в foreground-окно, readback langid; явный en/ru при несовпадении -> ошибка.
- `exec` (`:266`): spawn `windowsHide`, вывод <= 1 МБ, таймаут 8 с.

### Office (`office.ts`)
`runExcel`/`runWord` (`:164/:170`): `assertReadable` (read) или `assertWritable` (остальное) ДО COM -> `withPathLock` (сериализация по нормализованному пути) -> temp-JSON с аргументами -> `powershell -Command <константа>` -> ищется строка `JARVIS_OFFICE_RESULT ` -> JSON. Excel: `read` (Range/UsedRange -> `values` строками), `write_cell`, `append_row`; Word: `read/write/append`. Headless, DisplayAlerts off, ретрай открытия 6x500 мс, `Quit`+`ReleaseComObject` в finally, таймаут 30 с -> `taskkill /T` + снятие только безоконных экземпляров Office (`killOfficeTree`, `:228`). Несуществующий путь -> создаётся (Excel SaveAs 51 = xlsx, Word SaveAs 16 = docx).

### Экран
- `captureScreen` (`screen.ts:58`): `pickDisplay` (индекс | primary | jarvis | cursor | иначе монитор ПЕРЕДНЕГО окна через сайдкар `window.list`, фолбэк - курсор; `JARVIS_CAPTURE_FOREGROUND=0` -> курсор) -> `grabNative` (thumbnailSize = размер монитора x scaleFactor, масштаб по РЕАЛЬНОМУ размеру миниатюры) -> `cropResize` под кап зрения (`fitSize`: длинная сторона и площадь, округление вниз) -> `registerFrame` (f полный / z зум / s выделение) -> `{image(base64 PNG), width, height, frameId, zoomOf?}`.
- Регион `rect`: в кадре `frame` (монитор кадра, не текущий) или `space:"screen"` (DIP); без обоих -> `NoFrameError` (догадок нет); вне монитора -> ошибка. Зум из неужатого кадра x2 по умолчанию, `scale` 0.25..2.
- `screenOcr` (`screen-ocr.ts:45`): нужен `sidecar().ready` (иначе `NotImplementedError`); натив региона, плитки для >2600 px (`screen-ocr-tiles.ts`), строки в системе кадра задачи или o-кадра; всегда `mapping{boundsX,boundsY,scale}`.
- `probeScreen` (`screen-probe.ts:20`): миниатюра <=256 px -> aHash 8x8 hex + средняя яркость; кадр не регистрирует; НЕ доказательство успеха.
- `waitFor` (`sensors-cheap.ts:188`): условия ui/window/text/sound/gsi/file/process/browser, таймаут 1..120 с, шаг опроса по виду; `met:false` + `unknown:true` = "не смог проверить", а не "не наступило"; вуаль помечает `veiled`.

### Невидимый браузер (`jarvis-browser.ts`)
Один экземпляр на процесс (`jarvisBrowser()`, `:510`), все операции под `AsyncMutex`. `ensureBrowser` (`:169`): жив ли CDP и NavGuard, иначе `launchWarm` (`:179`): свободный порт, `startPinProxy` (SOCKS5, суд DNS при подключении), Chrome с профилем `%LOCALAPPDATA%\JarvisTG\tg-profile` (ASCII-фолбэк), окно на x >= 40000 за краем всех мониторов, флаги против occlusion/backgrounding, `--remote-allow-origins=http://127.0.0.1:<port>`; `NavGuard` (браузерное CDP-соединение) до первого действия; ожидание 2.5 с. Простой 5 мин -> закрытие (не рвёт занятый лок). Примитивы: `open` (только http(s), `safeBrowserUrl` + `isPrivateHost`, после навигации `assertNotBlocked`), `read`, `inspect`, `act` (те же page-функции, что у расширения: `elementActIsolated`, `robustClickMain`), `importCookies`, `openLogin` (ВИДИМОЕ окно того же профиля), `telegramSend/Read` (webK: резолв получателя `pickRecipient`, `Input.insertText`, Enter, поллинг своего пузыря 8 с). Telegram: исходы delivered / "не подтверждена (могло и уйти)" / ошибка `[tg-resolve]`.
`CdpBrowserController` (`browser-cdp.ts:84`) - отдельный путь для `browser.open` (без inDefault): Chrome/Edge с CDP, при сбое `index.ts:342-349` откатывается на `apps.launchApp`.

### Код (`code-runner.ts`)
`run` (`:158`): cwd = свежий `mkdtemp` или явный существующий каталог; окно = `timeoutMs` (кламп 1..180 с) либо `JARVIS_CODE_TIMEOUT_MS` (5..180 с, деф. 30 с); env = `runnerEnv` (`:90`, без `*key|secret|token|password|passwd|credential*` и значений вида `scheme://user:pass@`); python получает `PYTHONIOENCODING=utf-8` и, если поднят мост, `JARVIS_ACT_URL/TOKEN` + `jarvis.py` на `PYTHONPATH`; вывод <= 64 КБ на поток (stdout - голова + отдельный хвост, stderr - хвост); таймаут: `taskkill /T /F` + жёсткое завершение через 2 с, `timedOut`, `exitCode:-1`. `dispatch` превращает `exitCode != 0` в ошибку (`index.ts:504-525`), выделяет остановку вуалью (`overlayDrawingFromCodeRun`), а exit 0 с маркером `[overlay_drawing]` в stderr - в `overlayCaught` (неподтверждённый исход).
Фон: `startJob` (`:309`, <=4 одновременно, вывод в файлы `%TEMP%/jarvis-job-*`, потолок жизни 24 ч, хранение итога 6 ч), `jobStatus` (`:354`, хвост 4000 симв., `kill`, маркер вуали ищется по ВСЕМУ stderr, берётся последний).

### Навыки (`skill-runner`)
`runSkill` (`index.ts:123`): для каждого шага cancel -> бюджет (`JARVIS_SKILL_REPLAY_BUDGET_MS` 10..80 с) -> needsLlm (`escalate`, иначе честный провал) -> предусловие (активное окно, `nameMode`) -> цикл попыток (`stepRetries`: коммит/неизвестно = 0 повторов, иначе <=5, деф. 2) -> `executeStep` -> `checkExpect` (auto-wait по wall-clock, visual = OCR-подстрока) -> вуаль/отказ рубежа (`denied`) без ретраев. Итог `SkillRunOutcome` -> `outcomeToActionResult` (`overlay_drawing` / `denied` / `runtime`, `stepIndex`, `stepActionInjected`). `createClientActuator` (`client-actuator.ts`) мапит шаги на `apps/ground/input`; USER_BUSY-гейт для проактивных; `input.type` <= 150 символов; `wait` <= 15 с.

### Инварианты (законы CLAUDE.md, проверяемые в этой области)
- Честность исхода: `focused/closed/deleted` реально сверяются; `volume set`, `layout` - readback; `pause` без звука не жмёт; fs.read бинарника - ошибка, не мусор; search несёт полноту; `wait.for` различает `unknown`; telegram - три исхода.
- §0: `assertReadable` не даёт читать `.env`/ключи и через `fs.view`, и через office, и через search (per-entry `isSecretPathFast`).
- §4: shutdown/restart никогда не `/t 0`; delete/move рекурсивно - защита поддерева.
- B-14: невидимый браузер не выходит во внутреннюю сеть (гард навигации + пиннинг DNS).
- Флаги этой области (для правила "один флаг - одно решение"): `JARVIS_SHUTDOWN_DELAY_SEC`, `JARVIS_CODE_TIMEOUT_MS`, `JARVIS_SKILL_REPLAY_BUDGET_MS`, `JARVIS_CAPTURE_FOREGROUND`, `JARVIS_FS_SEARCH_SCAN_CAP`, `JARVIS_FS_SEARCH_BUDGET_MS`, `JARVIS_ALLOW_MOCK_SEND`; `OBS_WEBSOCKET_HOST/PORT/PASSWORD`; тестовый `JARVIS_LIVE_SYSTEM`.

## 2. Возможности (все в JSON)
Сводка по видам. Формы результатов - из кода (`data` в `ActionResult`).

| Вид | Вход | Результат (реальная форма) | Побочный эффект на ОС |
|---|---|---|---|
| `fs.read` | path, maxBytes, offset/lines/tail | `{path, bytes, truncated, encoding, totalLines?, range?, note?, content}` | нет |
| `fs.write` | path, content, createDirs | `{path, bytes, created}` | создаёт/перезаписывает файл |
| `fs.edit` | path, old, new, replaceAll | `{path, replacements, bytes}` | перезапись файла |
| `fs.append` | path, content | `{path, bytes}` | дописывает |
| `fs.list` | path, recursive | `{path, entries:[{name,path,type,size}], truncated}` (кап 5000) | нет |
| `fs.delete` | path, recursive | `{path, deleted:true}` | необратимо |
| `fs.move` | from, to | `{from, to}` | rename / copy+rm |
| `fs.mkdir` | path | `{path}` | создаёт каталоги |
| `fs.search` | root, query, inContent, maxResults, ignore | `{truncated, stopReason?, scannedFiles, exhausted, ignoredDirs, skipped*, note?, matches[]}` | нет |
| `fs.view` | path, page, maxSide | `{path, image(b64), mediaType, width, height, format, bytes, resized, page?, pageCount?, rendered?, note?}` | нет (PDF: python) |
| `system.lock` | - | `{ok:true}` | блокирует сессию |
| `system.power` | op sleep/shutdown/restart/logoff/cancel | `{ok:true}` | усыпляет / отложенно выключает / выходит |
| `system.media` | op play/pause/next/prev/stop/state | state: `{ok, playing, peak}`; pause в тишине: `{ok, playing:false, already:true, peak}` | глобальная медиа-клавиша |
| `system.volume` | op get/set/up/down/mute, level | `{ok, level}` или `{ok, muted}` | меняет громкость/mute устройства |
| `system.clipboard` | op read/write, text | read: `{ok, stdout}`; write: `{ok}` | пишет в буфер |
| `system.layout` | lang en/ru/toggle | `{ok, stdout:"en"/"ru"/langid}` | меняет раскладку foreground-окна |
| `office.excel` | op read/write_cell/append_row, path, sheet, range, cell, value, row | `{ok, op, values?/cell?/row?}` | правит/создаёт .xlsx, запускает EXCEL.EXE |
| `office.word` | op read/write/append, path, text | `{ok, op, text?}` | правит/создаёт .docx, запускает WINWORD.EXE |
| `screen.capture` | monitor, rect, scale, maxEdge, maxPixels | `{image, mediaType:"image/png", width, height, frameId, zoomOf?}` | регистрирует кадр |
| `screen.ocr` | monitor, rect, lang, frame | `{text, lines[{text,x,y,w,h}], width, height, frameId?, frame?, mapping}` | регистрирует o-кадр |
| `screen.probe` | monitor, rect | `{hash, mean, width, height}` | нет |
| `wait.for` | condition, timeoutMs, pollMs | `{met, elapsedMs, polls, detail, unknown?, veiled?, gsiState?}` | нет |
| `code.run` | lang, code, cwd, timeoutMs, background | sync: `{stdout, stderr, exitCode, truncated, timedOut?, stdoutTail?}`; ошибка при `exitCode != 0`; bg: `{jobId, pid, cwd, logDir, startedAt, background:true, note}` | ВСЁ, что сделает скрипт (без песочницы, политика владельца) |
| `job.status` | jobId, kill | `{jobId, lang, cwd, running, exitCode?, elapsedMs, stdoutTail, stderrTail, logDir, killed, error?, overlayMarker?}` (+ `overlayStopped/overlayCaught`) | kill валит дерево процессов |
| `skill.execute` | skillId, version, steps, params | ok + `{observation}`; иначе error + `stepIndex`, `stepActionInjected?`, `data.needsApproval?` | клики/ввод/запуск по шагам |
| `jbrowser.open/read` | url | `{title, url, text, loginWall?}` | навигация в невидимом Chrome |
| `jbrowser.inspect/act/login/import_cookies` | query / intent+params / url / cookies | `unknown` / `{ok:true,...,blockedNav?}` / `{opened}` / `{set,total}` | действия в залогиненных сессиях; login открывает ВИДИМОЕ окно |
| `telegram.send/read` | to, text/count, hint | `{delivered, chatTitle, peerId?}` / `{chatTitle, messages[{dir,text}]}` | сообщение уходит человеку |
| `browser.open` | url, inDefault | `{url, controlled}` (+ поля launchApp) | открывает вкладку/процесс браузера |
| `order.place` | vendor, items, total | ВСЕГДА ошибка "не реализован (M7)" | нет |
| `message.send` | channel, to, body | `{messageId}` или ошибка "канал не подключён" | userbot-отправка |
| `obs.request` | requestType, requestData | responseData obs-websocket | управляет OBS |
| `audio.sessions/set` | pid/process, mute, level | `{sessions[]}` / результат применения | mute/громкость приложения |
| `monitor.set/list/assign` | target/index | сводка мониторов (`monitors.ts`) | только внутреннее состояние |

## 3. Швы (seams)
| Шов | Где | Как подменить в лаборатории |
|---|---|---|
| Электрон: `desktopCapturer/screen/nativeImage/powerMonitor/clipboard` | `screen-grab/native/display.ts`, `index.ts:15` | `vi.mock("electron")` -> `test-support/fake-capturer.ts` (`resetCapturer([{id,bounds,scaleFactor}])`, картинка помнит происхождение пикселей) и `electron-mock.ts` (`resetElectronMock({scale, idleSec, ownFocused})`). Настоящий Electron: только Linux+Xvfb (`frames-xvfb.test.ts`, `xvfb-frames-smoke.ts`); в песочнице агента на Windows Electron падает на GPU |
| Сайдкар (UIA/OCR/window.list/input) | `actuators/sidecar-client.ts` (`sidecar()`) | `test-support/fake-sidecar.ts` (`fakeSidecarModule()`, `useFakeSidecar()`) - формы как у C# `Ipc.cs`, журнал мутаций |
| PowerShell/rundll32/shutdown/taskkill | `system.ts:266 exec`, `office.ts:192`, `audio-sessions.ts`, `apps.ts` | ЯВНОГО DI НЕТ (`spawn` зашит). Варианты: (а) подложить в `PATH` записывающие шимы `powershell.exe`/`shutdown.exe`/`rundll32.exe` (спавн по имени); (б) добавить DI-точку `setSpawn()` (нужна правка кода). `planSystem` - чистая, проверяется без запуска |
| Файловая система | `fs.ts` `expandPath` | песочница: абсолютные пути во временном каталоге + `USERPROFILE`/`HOME` на песочницу для `~` и относительных; `self-guard` продолжает работать (`fs.test.ts` так и делает) |
| Буфер обмена | `system.ts` (PowerShell), НЕ electron | шим `powershell` или (на Windows-стенде) реальный буфер с бэкапом/восстановлением |
| Часы | `Date.now`/`setTimeout` почти везде | `vi.useFakeTimers()`; в skill-runner есть DI `sleep/now/veiledSince/overlayBlockReason`; в `waitFor` DI нет |
| Chrome | `JarvisBrowserOpts` (`jarvis-browser.ts:131`): `chromePath, extraArgs (headless/no-sandbox), profileDir, startUrl, settleMs, resolveHost, mapAddress` | `test-support/jb-fixtures.ts`: `findChrome()`, `fixture()`, `launchJarvisBrowser()`, "DNS" стенда `fixtureLookup`, `CHROME_PATH` |
| CDP-контроллер `browser.open` | `CdpBrowserController` opts `{headless, chromePath, userDataDir}` | `browser-cdp.test.ts`, `cdp-core.test.ts` (WS-фейк) |
| Интерпретаторы code.run | `interpreter()` `code-runner.ts:~113` | реальные `python`/`node`/`powershell` из PATH; cwd -> песочница; `setActBridge(undefined)` отключает jarvis SDK |
| Мост SDK | `setActBridge` (`code-runner.ts:40`) | в лаборатории поднять реальный `act-bridge.ts` (тест `act-bridge.test.ts`) |
| OBS | `OBS_WEBSOCKET_HOST/PORT/PASSWORD` | локальный фейк-WS сервер v5 нужно написать: `obs.test.ts` проверяет только формулу `obsAuthSecret`, самого `request` (handshake/Identify/Request) в тестах нет |
| Userbot | `messaging.ts` `SenderRegistry` | `MockSender` + `JARVIS_ALLOW_MOCK_SEND=1` (без флага mock не отправляет - fail-closed) |
| Реплей навыков | `SkillActuator` (`skill-runner/index.ts`) | подсовывать свой актуатор (весь `skill-runner/index.test.ts` так и построен) |
| Сквозной стенд | `test-support/server-link.ts` | настоящий серверный `dispatchTool` + настоящий клиентский `dispatch` в одном процессе, фейки только по краям |
| Вуаль | `selection/store.ts` singleton | вручную включать `selectionStore.drawing` через его API |

## 4. Как проверять без человека
Условные обозначения: U = юнит/интеграция достаточно; FS = песочница файлов; FD = fake-desktop (fake-sidecar + fake-capturer); LIVE = нужен Windows-хост.

| Возможность | Чем проверяется | Что есть | НЕ покрыто |
|---|---|---|---|
| fs.* | U + FS | `actuators/fs.test.ts`, `fs-honesty*.test.ts`, `fs-read-window.test.ts`, `fs-search-ignore.test.ts`, `self-guard.test.ts` | edit на не-UTF-8 файле; кириллица/cp1251 в edit/append; UNC/OneDrive; поведение на Windows-путях под Linux-CI |
| fs.view | U (мок nativeImage + фейк python) | `file-view.test.ts` (32 кейса) | реальный PyMuPDF и реальный декодер Electron - LIVE/или Linux с pymupdf |
| system.* (план) | U | `system.test.ts` (`planSystem`, `pauseKeyNeeded`) | исполнение `runSystem` без железа: нет DI на spawn |
| system.volume/media/layout/clipboard (эффект) | LIVE | `system.integration.test.ts` (только `JARVIS_LIVE_SYSTEM=1`, меняет громкость, потом возвращает) | media-клавиши next/prev/stop, layout, clipboard, lock/power не тестируются живьём вообще; в лаборатории нужен шим |
| office.* | скрипты/аргументы - U; COM - LIVE (нужен установленный Office) | `office.test.ts`, `office-injection.test.ts` (гард до COM) | реальный Excel/Word: read/append_row/таймаут-kill, кодировка, параллельные вызовы; ретрай 6x500 |
| screen.capture / зум / OCR | FD | `screen-capture.test.ts`, `screen-ocr.test.ts`, `frames*.test.ts`, `observe-*.test.ts`; живой смоук Xvfb `frames-xvfb.test.ts` (Linux) | реальный Windows desktopCapturer/DPI/мультимонитор; `pickDisplay` через настоящий `window.list` |
| screen.probe | FD | косвенно `dispatch-honesty.test.ts`, `selection.test.ts` | сам aHash на реальных картинках |
| wait.for | U + fake timers + fake-sidecar | `dispatch-honesty.test.ts`, `wait-file-process.test.ts`, `observe-*.test.ts` | ветки browser/gsi/sound на живых источниках |
| code.run sync | U (реальные интерпретаторы) | `code-runner.test.ts` (`runnerEnv`), `code-runner-jobs.test.ts` (кодировка python, усечение головы/хвоста, cwd, `timeoutMs` -> exitCode -1), `jarvis-sdk-*.test.ts` | kill ДЕРЕВА внуков по таймауту, hard-resolve через 2 с, powershell-ветка, python с мостом на живом `act-bridge` |
| code.run bg / job.status | U | `code-runner-jobs.test.ts` (start/status/kill/маркер вуали), `apps/server/src/brain/tools/handlers/code-background.test.ts` | 24-ч watchdog, sweep, поведение при выходе клиента |
| skill.execute | U с фейковым `SkillActuator` | `skill-runner/index.test.ts` (686 строк), `client-actuator.test.ts`, `step-policy.test.ts`, `focus-step.test.ts`, `rubezh-replay.test.ts` | реальный UIA-реплей (LIVE + сайдкар), связка с отменой задач (её нет), `escalate` |
| jbrowser.open/read + B-14 | настоящий Chromium | `jarvis-browser-ssrf/pin/dns.chromium.test.ts`, `-nav-guard.test.ts`, `-proxy*.test.ts` (пропускаются без Chrome) | `act` на живых страницах (page-функции покрыты стендом расширения `apps/extension/test`); `importCookies`; idle-close; логин-окно |
| telegram.send/read | LIVE + owner (аккаунт и реальный webK) | нет клиентского теста на `__tg` | вся ветка webK (`jarvis-browser-page.ts`): резолв, verify, not-logged-in - только по фикстуре-копии вёрстки (нужно завести) |
| browser.open (CDP) | U | `browser-cdp.test.ts` | реальный Chrome-запуск на профиле |
| obs.request | U с фейк-WS (его нет) | `obs.test.ts` (только строка аутентификации) | весь `request()`: handshake, ошибки, таймаут; реальный OBS |
| message.send | U | (нет отдельного клиентского теста; guard fail-closed в коде) | - |
| audio.sessions/set | U (парсер) + LIVE | `audio-sessions.test.ts` | реальный Core Audio |
| dispatch (вуаль, USER_BUSY, честность) | U + FD | `dispatch-honesty.test.ts`, `focus-veil.test.ts`, `frames-dispatch.test.ts` | - |

liveOnly (нельзя без железа/владельца): `system.lock/power(sleep|logoff|shutdown)` эффект, media-клавиши, `system.layout`, `office.*` эффект, Windows-захват экрана, `telegram.*`, `jbrowser.login`, `import_cookies` с боевыми куками, реальный OBS, `audio.set`.

## 5. Дефекты и долг
| Серьёзность | Где | Что |
|---|---|---|
| med | `packages/protocol/src/constants.ts:71-96` + `office.ts:35` | У `office.excel/office.word` нет своего серверного таймаута: дефолт 15 с, клиентский таймаут COM 30 с, ретрай открытия до 3 с, холодный запуск Office 3-10 с. Ложный "таймаут" при успешной записи -> модельный повтор `append_row` дублирует строку. Класс баг из комментария у `input.click` |
| med | `fs.ts:342,353,359` | `editFile` читает и пишет `utf8` без sniff: файл в cp1251/UTF-16 (который `fs_read` честно читает) при правке превращается в мусор; `fs.append` в UTF-16 файл добавляет utf8-байты. Молчаливая порча данных |
| med | `system.ts:280-287` | Таймаут 8 с делает `resolve(out)`, а не reject: зависший PowerShell = `{ok:true}` для lock/media/clipboard.write/power (у volume/layout спасает readback). Ложный успех без сверки; у `clipboard.write` readback вообще нет |
| med | `index.ts:584,598-603` | `skill.execute`: `cancel` не связан с отменой задачи (TODO M8) - "стоп" не останавливает реплей до 80 с; `escalate` не подключён -> любой `needsLlm`-шаг всегда провал (заявленный механизм слотов по месту мёртв) |
| med | `jarvis-browser.ts:482-488` | Видимое окно входа запускается с `--remote-debugging-port` и без `--remote-allow-origins`, хотя CDP там не нужен; на логин-профиле любой локальный процесс без Origin может подключиться к CDP. Тёплый браузер (`:188-191`) ограничивает только Origin - клиенты без заголовка Origin проходят |
| med | `constants.ts` (нет кейсов `jbrowser.*`), `web-act.ts:71`, `web-place.ts:90` | `jbrowser.*` получают 15 с, а холодный `launchWarm` = settle 2.5 с + до 15 с на CDP + до 15 с `waitLoad` + 0.8 с; `jbrowser.open/act` в холодную могут дать ложный таймаут (`telegram.send` спасён явными 90 с в `messaging.ts:154`) |
| low | `skill-runner/client-actuator.ts` (ветки `default`, `ui.ground`) | Неизвестное действие шага логируется и возвращает успех; `ui.ground` с не-role target - тихий no-op. Ложный "шаг выполнен" при порче контента навыка |
| low | `system.ts:167` | `SetSuspendState 0,1,0` при включённой гибернации известно уходит в гибернацию, а не сон (поведение утилиты; не проверено на этом ПК). `logoff` (`:175`) - мгновенно, без окна отмены: защита только confirm на сервере |
| low | `fs.ts:412,366` | `makeDir` без `assertWritable`, `listDir` без `assertReadable` (имена файлов секретных каталогов отдаются; рекурсивный список ходит внутрь `node_modules` до кап 5000 без игнора) |
| low | `code-runner.ts:290-330,422` | Реестр заданий только в памяти: после рестарта клиента `job.status` -> "задание неизвестно", а дочерние процессы, запущенные `startJob`, не убиваются при выходе клиента (логи в `%TEMP%` копятся: `sweepJobs` вызывается лишь из `startJob`) |
| low | `code-runner.ts:90-98` | `runnerEnv` - денилист (по имени и URL-с-паролем); секрет в переменной с безобидным именем и не-URL значением уйдёт в скрипт с сетью. CLAUDE.md требует позитивные allowlist'ы |
| low | `office.ts:65,70` | `read` приводит все ячейки к `[string]` Value2 (даты - серийные числа, типы теряются), выборка без капа строк (огромный `UsedRange` = 30 с таймаут, вывод режется 4 МБ). `write_cell`: значение всегда строкой/JSON-типом без формулы/формата |
| low | `jarvis-browser.ts:148,219,254` | Поле `injected` присваивается и нигде не читается (мёртвый код) |
| low | `browser.ts:35` + `index.ts:709` | `order.place` - заглушка, всегда бросает; kind живёт в протоколе и dispatch (мёртвый путь, честный). `demo.record` -> `notImplemented` |
| low | размеры файлов | Законы "<150 строк": `index.ts` 793, `fs.ts` 532, `jarvis-browser.ts` 513, `code-runner.ts` 481, `jarvis-browser-page.ts` 253; `dispatchInner` - один switch на ~500 строк. Рефакторинг без запроса не делается |
| low | флаги | 7 `JARVIS_*` только в этой области (`SHUTDOWN_DELAY_SEC`, `CODE_TIMEOUT_MS`, `SKILL_REPLAY_BUDGET_MS`, `CAPTURE_FOREGROUND`, `FS_SEARCH_SCAN_CAP`, `FS_SEARCH_BUDGET_MS`, `ALLOW_MOCK_SEND`): кандидаты на слияние/удаление |
| info | `index.ts:15`, `system.ts` | В области НЕТ актуаторов "уведомления" и "процессы" (toast/list processes): искать в других местах; закрытие приложений - `apps.closeApp` (`index.ts:314`), ожидание процесса - `wait-file-process.ts` |

## 6. Что лаборатория обязана уметь ради этой области
1. Песочница ФС: временный корень, подмена `USERPROFILE/HOME/TEMP/APPDATA`, набор файлов-фикстур (utf8, utf8-BOM, utf16, cp1251, бинарник, PDF, картинки, симлинк/junction, `.env`, `node_modules`), проверка результата на диске.
2. Шим-слой процессов ОС: записывающие `powershell/shutdown/rundll32/taskkill` (с программируемым stdout, кодом и зависанием) либо DI на `spawn`; иначе `system.*`/`office.*`/`audio.*` не проверить без железа. Реальный Windows-стенд нужен только для отдельного LIVE-набора (сейчас гейт `JARVIS_LIVE_SYSTEM=1`).
3. Виртуальный монитор: fake-capturer с произвольными мониторами/масштабами + синтетический "скриншот" (заданные слова в физических координатах) + fake-sidecar OCR; желательно Linux+Xvfb+настоящий Electron для `screen.*`.
4. Часы: управляемое время для `waitFor`, `runSkill` (DI уже есть), таймаутов code-runner/office/system.
5. Интерпретаторы: `python`/`node`/`powershell` в PATH лаборатории, cwd-песочница, отключаемый jarvis-мост, проверка kill дерева и `timedOut`.
6. Chromium + фикстурные сайты (`jb-fixtures.ts`) с headless-профилем; фикстура-копия вёрстки Telegram webK для `__tg` (сейчас нет).
7. Фейк-WS OBS, `MockSender`, фейк Core Audio (через шим).
8. Сквозной клиент+сервер (`server-link.ts`) как основной транспорт лабораторных сценариев; сверка `ActionResult` с формами из раздела 2.
9. Регрессионные сценарии на найденные дефекты: office-таймаут 15 с, edit не-UTF-8, `exec` таймаут как успех, отмена реплея навыка.
