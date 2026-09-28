# client-actuators-gui — GUI-актуаторы клиента (окна, ввод, приложения, UIA, OCR, act)

Область: `apps/client/main/actuators/` (dispatch `index.ts` + GUI/окна/ввод/приложения/UIA/OCR/act/рубеж инжекции/кадры/мост SDK) и нативный сайдкар `apps/sidecar-win` (C#). Соседние карты: fs.*/code.run/jbrowser.*/telegram.*/message.send/order.place/office/obs/system — не GUI, здесь только перечислены как «чужие» ветки dispatch. Чтение ONLY; ничего не запускалось.

## 1. Как работает

### 1.1 Сквозной поток
```
сервер (dispatchTool: tool -> ActionCommand)  --WS/JSON-->  Transport (main/transport)
  -> serverExecutor(dispatch)  [approval-scope.ts:54  открывает ОБЛАСТЬ ОДОБРЕНИЯ via:"server" (ALS)]
  -> dispatch() [index.ts:211]  = dispatchInner + пометка вуали
       1) гейт вуали режима выделения (index.ts:251)      -> error.overlay_drawing
       2) гейт USER_BUSY только для proactive (index.ts:266) -> error.denied
       3) снимок UIA «до» (needsBeforeSnapshot, index.ts:292)
       4) switch(cmd.kind)  (index.ts:294..778) -> актуатор
       5) catch: actionErrorOf(e) -> код/данные/injected; иначе runtime (index.ts:779)
  -> ActionResult {commandId, ok, data|error{code,message}, durationMs, stepIndex?, stepActionInjected?}
```
Мутации GUI всегда идут: актуатор -> `injectRpc` (inject.ts:18) -> `guardInjection` (injection-guard.ts) судьи по порядку **self -> secret -> commit** (JUDGES) -> `noteInjected` (журнал набранного/памяти клика) -> `sidecar().request(op, params)`. Прямой `sidecar().request` для мутаций запрещён; единственное осознанное исключение — `releaseHeldPointer` (input.ts:289).

Код ошибки протокола: `runtime | denied | not_found | overlay_drawing | ...` (`errResult` index.ts:191). Ложный успех запрещён: `app.focus` при `focused:false` -> not_found (index.ts:304); `app.close` при `closed===0` -> not_found (index.ts:321); `window.focus` провал любой ветки -> runtime (index.ts:442); `code.run` exit!=0 -> runtime.

### 1.2 Сайдкар SidecarWin.exe (C#, NDJSON по stdio)
`sidecar-client.ts`: `JsonLineRpc` (id-корреляция, таймаут по умолчанию 5 с, `request` бросает СИНХРОННО если `!ready`), `SidecarClient` (spawn, авто-рестарт 1 с -> x2 -> 30 с, сброс бэкоффа после 60 с аптайма, `generation` +1 на старт — handle UIA живут внутри поколения, `onPush` для событий без id: `user-input`, `demo`).
Операции (Program.cs:99..144): `ground`, `ground.at`, `invoke`, `click`, `type`, `key`, `read.selection`, `read.window`, `read.screen`(=read.window), `raw-input.subscribe`, `demo.record`, `ui.snapshot`, `window.list`, `window.focus`, `mouse`, `ocr`. Читающие (`ground, ground.at, read.*, ui.snapshot, window.list, ocr`) идут в thread-pool параллельно; мутирующие (`click,type,key,mouse,invoke,window.focus`) строго последовательно (Program.cs:36..).
Таймаут RPC НЕ отменяет операцию в C#: просроченная мутация может исполниться позже — поэтому `act-do.ts` при таймауте invoke делает `ActPartialError` (без повтора физическим кликом).
Путь exe: `main/index.ts:766..770` (`resources/sidecar-win.exe` либо `apps/sidecar-win/bin/Release/net8.0-windows10.0.19041.0/win-x64/publish/SidecarWin.exe`). Нет exe -> `ready=false`, все UIA/ввод-актуаторы кидают `NotImplementedError` (-> runtime), а не молчат.

### 1.3 Ключевые файлы
| Файл | Роль |
|---|---|
| `index.ts` | dispatch, `willObserve/needsBeforeSnapshot/plannedClickPoint`, `userActiveNow/ownerPresenceNow` |
| `inject.ts`, `injection-guard.ts`, `injection-facts.ts`, `injection-journal.ts` | рубеж инжекции: факты (window.list/ground.at/read.screen, дедлайн 4 с, мемо) + судьи |
| `self-judge.ts`, `secret-judge.ts` (+`secret-*.ts`, `paste-guard.ts`, `focused-field.ts`), `commit-judge.ts` (+`commit-*.ts`) | свой процесс (неодобряемо), §0 секреты/карты (неодобряемо), §14 коммит по гранту области |
| `approval-scope.ts` | ALS-область одобрения: `server` (гранты, счётчик списывается), `bridge`/`local` (без одобрения, fail-closed), `expectedForeground` (G-11) |
| `input.ts`, `type-chunks.ts`, `paste-text.ts`, `input-mark.ts`, `input-buffer.ts`, `held keys` | ввод: `pressKey` (блок-лист комбо + удержание), `click` (лестница), `mouse`, печать кусками, вставка длинного через буфер |
| `ground.ts`, `handle-mirror.ts`, `process-of.ts`, `handle-click.ts`, `point-policy.ts` | UIA: ground/ground.at/snapshot/invoke, зеркало handle, «крупный контейнер — не кнопка» |
| `act.ts`, `act-args.ts`, `act-find.ts`, `act-find-ocr.ts`, `act-do*.ts`, `act-verify.ts` | gui.act: фокус окна -> поиск цели -> снимок до -> действие -> сверка |
| `observe.ts` | fused-наблюдение после действия (a11y-дельта / OCR-дельта; `JARVIS_FUSED_OBSERVE`) |
| `sensors-cheap.ts`, `screen*.ts`, `screen-ocr*.ts`, `frames.ts`, `coords.ts`, `snapshot-frame.ts` | зрение: capture/ocr/probe/wait.for; кадры задачи (LRU 64) и перевод координат |
| `windows.ts`, `window-arrange.ts`, `apps.ts`, `app-resolve.ts`, `launch-window.ts`, `windows-builtins.ts` | окна и приложения |
| `act-bridge.ts`, `bridge-exec.ts`, `bridge-find.ts`, `bridge-uri.ts`, `jarvis-sdk-source.ts` | loopback-HTTP мост для python SDK `jarvis.*` из code_run |
| `self-guard.ts` | рельсы самоправки (пути, node_modules, .env, ключевые контейнеры) — для fs.*, читается и GUI |

### 1.4 Инварианты (нарушение = дефект)
1. **Один путь мутаций**: только `injectRpc`. Реверт-подсказка в `injection-seam.test.ts:5` (заменить на `sidecar().request` -> мутация дойдёт до фейка).
2. **Порядок гейтов**: вуаль (состояние системы) -> политика (запрет комбо: `isBlockedCombo`) выше состояния -> рубеж судей. `pressKey` держит ЗАПРЕТ выше вуали (input.ts:88 vs :109).
3. **Вуаль режима выделения**: физический ввод/фокус окна отклоняется `overlay_drawing`; проверка ДО (`assertNoDrawingOverlay`) и ПОСЛЕ RPC (`assertNoOverlayDuring(t0)`) — ушло, исход не подтверждён. `input.key{mode:up}` и бесшумный UIA-invoke не гейтятся.
4. **Одобрение §14 только из ALS-области серверной команды**; SDK-мост/реплей/UI = fail-closed; `approval` из тела моста срезается (`bridge-exec.ts`).
5. **Честный исход**: `gui.act` возвращает `verified: met|failed|unchecked`; повтор ТОЛЬКО если ничего не ушло (`ActPartialError.injected` -> `stepActionInjected`). Таймаут invoke != «не сработало».
6. **USER_BUSY**: физический ввод глушится только при `origin==="proactive"`; запрошенный владельцем ввод не блокируется (index.ts:265).
7. **Координаты модели — только в кадре** (`frames.ts`): без кадра/`space:"screen"` — `NoFrameError`; вытесненный кадр — `UnknownFrameError`; точка вне картинки — `OutOfFrameError`.
8. **Блок-лист комбо + удержание**: Alt(down)+F4(press) собирается по `heldKeys` и блокируется (input.ts:97); провал повторного down не стирает чужой вклад.
9. **Секреты**: карта (Луна) и поля пароля/кода — отказ без вопроса; автоввод менеджера паролей — отказ.
10. **Закрытие приложений** — только `app.close` по процессу (`CRITICAL_PROCESSES` apps.ts:101, wildcard `*?` запрещены, PowerShell env-передача), не Alt+F4.

### 1.5 Таймеры и константы
`USER_ACTIVE_THRESHOLD_MS=4000`, `JARVIS_INPUT_TOLERANCE_MS=900` (index.ts:58,73); `SKILL_REPLAY_BUDGET_MS` 10..80 с (env `JARVIS_SKILL_REPLAY_BUDGET_MS`, дефолт 80 с, серверный потолок 130 с); `ACT_BUDGET_MS=45000` (act.ts, серверный 60 с); `UIA_TIMEOUT_MS=12000`; `FACTS_DEADLINE_MS=4000`; verify: дефолт 4 с / макс 15 с / опрос 700 мс; `SNAPSHOT_MAX_ITEMS=200`; поиск: снапшот >=3 с остатка, OCR >=8 с; drag-поиск цели `to` 15 с; `LAUNCH_WINDOW_WAIT_MS=5000`; `PASTE_FROM_CHARS=80`, `PASTE_SETTLE_MS=400`, `TYPE_INSTEAD_MAX_CHARS=250`; печать: `min(180000, 5000+len*120)` мс на кусок; wait.for дефолт 30 с, максимум 120 с; `FRAME_LRU_MAX=64`; рестарт сайдкара 1..30 с.

### 1.6 Что возвращает каждый ActionCommand.kind (GUI-ветка)
| kind | ok.data | типичные ошибки |
|---|---|---|
| `app.launch` | `{resolved,pid?,display?,kind,source,confirmed,verified(process/appid/appid-already/handoff),window?,windowSeen?,note}` | runtime (`LaunchError`: не резолвится/умер мгновенно/нет признаков Steam), overlay_drawing |
| `app.focus` | `{resolved,focused:true}` | not_found (`focused:false`) |
| `app.close` | `{resolved,closed:N}` | not_found (closed=0), runtime (защищённый процесс, wildcard) |
| `browser.open` | `{url,controlled:true}` либо `{...launch,controlled:false[,inDefault]}` | runtime |
| `input.type` | `{observation?}` | denied (рубеж, +`needsApproval`), overlay_drawing, runtime (NotImplemented) |
| `input.key` | `{observation?}` (для down/up без наблюдения) | runtime (`BlockedKeyError`), denied, overlay_drawing |
| `input.click` | `{screenX,screenY,pressed?,observation?}` (только для coords-цели) | denied, overlay_drawing, runtime (`NoFrameError` и т.п.) |
| `input.mouse` | `{op,observation?}` | runtime (`PointerAutoReleasedError`), overlay_drawing, denied |
| `gui.act` | `{found?{via,name,role,handle,note,query},focused?,did,physical,screenX?,screenY?,verified,detail,observation?}` | runtime (+`stepActionInjected`), denied, overlay_drawing; `ActFindError` -> runtime со списком видимого |
| `ui.invoke` | `{observation?}` | runtime (setValue без значения; по координатам), denied |
| `ui.ground` | `{handle,bbox{x,y,w,h ФИЗ.},name?,role?}` | runtime «элемент не найден» |
| `ui.snapshot` | `{window,pid,items[{handle,role,name,automationId,value,x,y,w,h}],truncated}` (bbox в кадре, если `frame`) | runtime |
| `window.list` | `{windows[{hwnd,pid,process,title,foreground,minimized,monitorIndex,monitor,rect}]}` (окна вуали отфильтрованы) | runtime |
| `window.focus` | `{focused,hwnd,title,monitorIndex?,monitor?}` или `{focused:true,hwnd,title,via:"AppActivate"}` | runtime (foreground-lock / не найдено) |
| `window.arrange` | `{...ArrangeResult,title,process}` | runtime |
| `audio.sessions` / `audio.set` | `{sessions[]}` / результат применения | runtime (нет подходящей сессии) |
| `screen.capture` | `{image b64,mediaType,width,height,frameId?,zoomOf?}` | runtime |
| `screen.ocr` | `{text,lines[],width,height,frameId?,frame?,mapping}` | runtime |
| `screen.probe` | перцептивный хеш региона | runtime |
| `wait.for` | `{met,elapsedMs,polls,detail,unknown?,veiled?,gsiState?}` | met:false — НЕ ошибка; `unknown:true` = «не смог проверить» |
| `context.read` | `{scope,text}` | runtime |
| `screen.selection` | start/view/clear (режим выделения) | runtime (нет выделения) |
| `skill.execute` | `outcomeToActionResult` (+`observation`,`veiled`) | runtime, denied |
| `demo.record` | всегда `runtime "not implemented (M4)"` (запись идёт мимо dispatch, main/index.ts:427..489) | — |

## 2. Возможности
Полный машинный список — в `client-actuators-gui.json` (поле `capabilities`). Группы: запуск/фокус/закрытие приложений; окна (list/focus/arrange, монитор); UIA (ground/ground.at/snapshot/invoke/read); ввод (key/type/click/mouse, лестница «тихо -> точка -> физика», вставка через буфер); gui.act (11 глаголов: click, double, right, triple, middle, hover, scroll, drag, type, set, toggle/select/expand, key); наблюдение и сверка (observe, verify, wait.for); зрение (capture/ocr/probe/selection/file view); рубеж инжекции (self/§0/§14); SDK-мост (jarvis.* из code_run, allowlist 17 видов + `ui.find`); присутствие владельца (idle, user-takeover push); звук по процессам; мониторы Джарвиса.

## 3. Швы (seams)
| Шов | Где | Как подменить в лаборатории |
|---|---|---|
| Сайдкар (UIA+SendInput+окна+OCR) | `sidecar-client.ts` `sidecar()` | Уже есть `test-support/fake-sidecar.ts` (FakeSidecar в РЕАЛЬНОЙ форме Ipc.cs, `handlers[op]`, `mutations()`); `vi.mock("./sidecar-client.js", fakeSidecarModule)`. Для «настоящей» лаборатории — процесс-двойник NDJSON по stdio (нужна путь-подмена в `startSidecar`, сейчас жёстко в `main/index.ts:766`). |
| Электрон: `screen`, `desktopCapturer`, `clipboard`, `powerMonitor`, `BrowserWindow` | `import "electron"` | `test-support/electron-mock.ts`, `fake-capturer.ts` (пиксели с «происхождением» по мониторам/масштабам); `coords.setScreenApi`; настоящий Electron под Xvfb — `frames-xvfb.test.ts` (только Linux, не на Windows). |
| Часы простоя владельца | `powerMonitor.getSystemIdleTime` (index.ts:149) + `input-mark.ts` (`noteJarvisInput/noteOwnerInput`) | electron-mock; `_resetJarvisInputForTest`. Push `user-input` от сайдкара -> `main/index.ts:778`. |
| PowerShell (запуск, AppActivate, закрытие, arrange, audio, system, office) | `apps.ts`, `app-resolve.ts`, `window-arrange.ts`, `audio-sessions.ts`, `system.ts` | env-подмены `JARVIS_START_MENU_DIRS/JARVIS_STEAM_ROOT/JARVIS_STEAM_REG_KEY/JARVIS_STEAM_WAIT_MS/JARVIS_LAUNCH_NO_EXEC`; для остального — `vi.mock` листьев (см. `dispatch-honesty.test.ts` `st`) или Windows-only живой прогон. |
| Sleep/тайминги | `sleep` из `@jarvis/shared`, `setTimeout` | `vi.useFakeTimers`; сейчас единого инжектируемого «часового» шва нет. |
| Мост SDK | `startActBridge(dispatch)` | принимает `dispatch` аргументом — тест без Electron (`act-bridge.test.ts`, `rubezh-bridge.test.ts`). |
| Сервер <-> клиент | `test-support/server-link.ts` | настоящий серверный `dispatchTool` + настоящий клиентский `dispatch` через JSON, фейки — края (`e2e/w2-server-client.test.ts`). |
| Рубеж: судьи | `JUDGES` (injection-guard.ts) | `vi.mock` каждого судьи (injection-seam.test.ts) либо настоящие + фейк-сайдкар (rubezh-*.test.ts). |
| Одобрение | `serverExecutor(dispatch)` / `runWithoutApproval` | конверт команды `approval`/`grants`; в тестах `rubezh-fixtures.ts`. |
| Dev-сессия сервера | `isDevSession(clientVersion)` (`server/gateway/dev-session.ts`) | текст-драйвер «действия клиента — фейк»: команды GUI на dev-сессии НЕ доходят до клиента. |

## 4. Как проверять без человека
Шкала: **U** — юнит/фейк-сайдкар достаточно; **S** — server-link e2e (настоящий сервер+клиент+фейк-сайдкар); **D** — нужен ФЕЙКОВЫЙ РАБОЧИЙ СТОЛ с состоянием (нет: FakeSidecar статичен — клик не меняет снапшот, окна не появляются, `type` не пишет в поле); **L** — liveOnly (реальная Windows/железо).

| Возможность | Уровень | Есть тесты | НЕ покрыто |
|---|---|---|---|
| dispatch: честные исходы app.focus/close/window.focus/code.run, wait.for unknown | U | `dispatch-honesty.test.ts` | monitor.set/assign/list, audio.set, screen.probe, obs.request, demo.record через dispatch |
| Вуаль (гейты, пометка, пост-проверка) | U | `focus-veil.test.ts`, `jarvis-sdk-veil.test.ts`, `window-arrange-veil.test.ts`, `selection/veil-policy.test.ts`, `pointer-release*.test.ts` | реальный оверлей Electron (L) |
| Рубеж инжекции | U/S | `injection-seam.test.ts`, `rubezh-commit/keys/bridge/replay.test.ts`, `secret-*.test.ts`, `e2e/w2-server-client.test.ts` | реальный UIA-элемент за handle (форма — из Ipc.cs, вручную) |
| gui.act (поиск, действие, сверка) | U | `act.test.ts`, `act-find.test.ts`, `act-find-ocr.test.ts`, `act-do.test.ts`, `act-verbs.test.ts`, `act-rubezh.test.ts` | побочное действие клика на состояние окна: verify только против моков (D) |
| Координаты/кадры | U + xvfb | `frames.test.ts`, `coords.test.ts`, `frames-dispatch.test.ts`, `screen-capture.test.ts`, `screen-ocr.test.ts`, `frames-xvfb.test.ts` (Linux) | Windows mixed-DPI мультимонитор (L) |
| Сайдкар-клиент (рестарт, generation) | U | `sidecar-client.test.ts`, `sidecar-generation.test.ts` | сам C# exe (нет тестов C# кроме `smoke-test.mjs`) |
| Наблюдение (a11y/OCR-дельта) | U | `observe-delta.test.ts`, `observe-ocr-delta.test.ts`, `observe-wiring.test.ts` | реальная динамика UIA после клика (D) |
| Запуск приложений | U + env-подмены | `app-resolve*.test.ts`, `apps.test.ts`, `launch-window.test.ts`, `windows-builtins.test.ts` | реальный Start-Process, Steam, UWP-стабы (L) |
| Печать/буфер | U | `paste-text.test.ts`, `input.test.ts`, `input-buffer.test.ts`, `held-keys.test.ts` | реальное поле приложения (D/L) |
| SDK-мост | U | `act-bridge.test.ts`, `jarvis-sdk-rubezh.test.ts`, `jarvis-sdk-veil.test.ts`, `secret-sdk.test.ts` | настоящий python-процесс с `JARVIS_SDK_PY` — лишь частично |
| Аудио по процессам, system, office, obs | U (разбор вывода) | `audio-sessions.test.ts`, `system.test.ts`, `office.test.ts`, `obs.test.ts` | реальный Core Audio/COM/OBS (L) |
| Присутствие/takeover | U | `user-presence.test.ts`, `input-mark.test.ts` | живой LL-хук сайдкара (L) |

**Главная дыра для лаборатории**: нет стейтфул-двойника рабочего стола. Нужен «FakeDesktop»: окна (z-порядок, фокус, свёрнуто), дерево UIA на окно, кнопки/поля с реакцией (invoke -> меняет дерево, type -> value, key Enter -> событие), OCR из «нарисованных» строк, курсор, монитор(ы) с масштабом. Тогда `verified: met|failed` и `observation` проверяются на изменяющемся состоянии, а не на заранее заданном снапшоте.

## 5. Дефекты и долг
| Серьёзность | Где | Что |
|---|---|---|
| med | `apps/sidecar-win/bin/Release/.../publish/SidecarWin.exe` (mtime 14.07) vs `Ipc.cs/UiaGrounder.cs/WindowManager.cs` (mtime 16.07) | Собранный exe СТАРШЕ исходников: правки C# от 16.07 в бинарь не попали (или пересобрать). Живой сайдкар может не совпадать с фейком/Ipc.cs. Проверить хэш/пересобрать перед живыми прогонами. |
| med | `sidecar-client.ts:218-221` + `main/index.ts:801` | `request()` — не async: при `!ready` бросает СИНХРОННО. `sc.request("raw-input.subscribe").catch(...)` внутри `setTimeout` (2.5 с после старта) не поймает — если сайдкар успел упасть, исключение уйдёт в main как uncaught. |
| low-med | `index.ts:424-449` | `window.focus` по одному `hwnd` (без `query`): `DrawingOverlayError` из `focusWindow` проглатывается в `sidecarErr` и превращается в `runtime "фокус не взят"` вместо `overlay_drawing` (кормит §7-эскалацию как провал модели). Ранний гейт (index.ts:251) закрывает лишь вуаль, открывшуюся ДО вызова. |
| med | `index.ts:584` | `skill.execute`: `cancel = {cancelled:false}` навсегда (`TODO(M8)`) — «стоп»/killswitch не останавливает реплей навыка (до 80 с физического ввода). |
| low | `index.ts:1-14` | Шапка dispatch устарела (упоминает «НЕ реализованы...»/M0-список; перечисляет не все виды). |
| low | `injection-guard.ts:6-8` | Шапка: «P0: судьи-заглушки (null)» — судьи давно реальные. Вводит в заблуждение. |
| low | `index.ts` (793 строки) | Нарушение «модуль < 150 строк» (старый файл, без запроса не рефакторим); dispatchInner ~500 строк одним switch, вкл. большой блок `code.run`/`job.status` с вуалью — кандидат на вынос. |
| low | `apps/sidecar-win/README.md` | Утверждает self-contained single-file 70–120 МБ; реальный publish — 153 КБ (framework-dependent). Комментарий C# про `ocr.limits` («до живой проверки») нигде в коде не реализован. |
| low | `windows.ts:14` | Импортирует `NotImplementedError` из `input.js` (тяжёлый граф), хотя класс вынесен в `sidecar-ready.ts` «против циклов» — остаток. |
| low | флаги | Лишние env в области: `JARVIS_FUSED_OBSERVE`, `JARVIS_CAPTURE_FOREGROUND`, `JARVIS_SKILL_REPLAY_BUDGET_MS`, `JARVIS_ALLOW_MOCK_SEND`, `JARVIS_LAUNCH_NO_EXEC`, `JARVIS_START_MENU_DIRS`, `JARVIS_STEAM_*` — часть тестовые швы; «один флаг — одно решение» стоит проверить (FUSED_OBSERVE=0 отключает основной механизм сверки). |
| low | `index.ts:664` | `demo.record` остаётся видом протокола, но dispatch всегда «not implemented (M4)»; реальная запись живёт в `main/index.ts:427..489` мимо протокола — мёртвая ветка типа. |
| info | `browser.ts:23-33` | `order.place` — `TODO(M7)`, честный провал вместо оформления (не GUI, соседняя карта). |
| info | `test-support/fake-sidecar.ts` | Фейк статичен: мутации всегда `{success:true}`, snapshot не меняется от действий — «успех» проверяется только по журналу вызовов. |

## 6. Что лаборатория обязана уметь
1. Стейтфул FakeDesktop за интерфейсом сайдкара (реальная форма Ipc.cs), включая процесс-двойник NDJSON для настоящего `SidecarClient` (рестарт, таймаут, `generation`, push `user-input`); путь exe должен подменяться.
2. Инжектируемый источник времени и простоя (`powerMonitor`, `Date.now`, `sleep`) — для USER_BUSY, verify-таймингов, бюджетов act/skill.
3. Прогон настоящего `dispatch` под `serverExecutor` с грантами/без (server-link) и через SDK-мост с реальным python.
4. Фейковые мониторы/масштабы с кадрами (fake-capturer) + OCR по «нарисованным» строкам; матрица 100/125/150/200 %.
5. Режим выделения (вуаль) как управляемое состояние (`selectionStore.setDrawing`), включая «вуаль открылась ВО ВРЕМЯ RPC».
6. Проверка бинарной совместимости: хэш exe против исходников C#; контрактный тест форм ответов Ipc.cs.
7. liveOnly-набор (реальный Windows/Steam/UWP/Core Audio/LL-хуки/DPI) вынести в отдельный список «ждёт владельца».
