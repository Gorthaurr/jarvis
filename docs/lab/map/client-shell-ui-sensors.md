# client-shell-ui-sensors — оболочка клиента, UI, сенсоры, выделение, транспорт, сайдкар, mobile

Область: `apps/client/main/index.ts` (bootstrap/трей/IPC), `main/transport/`, `main/sensors/`, `main/selection/`,
`main/{settings-store,monitors,submit-text,owner-quit,device-token-store,identity-store,ipc-contract}.ts`,
`preload/*`, `renderer/*` (без audio.ts/capture-starter — это слух), `apps/sidecar-win` (C#), `apps/mobile`.
Всё прочитано, ничего не запускалось. Номера строк — на ветке `feat/jarvis-lab` (dc3c737).

## 1. Как работает

### 1.1 Поток «сервер ⇄ клиент ⇄ окно»
```
сервер /ws  <──JSON Envelope──>  Transport (transport/index.ts)  <──EventEmitter──>  main/index.ts (склейка)
                                       │ action.command                                     │ webContents.send(IPC.*)
                                       ▼                                                    ▼
                         serverExecutor(dispatch) → актуаторы → sidecar (stdio JSON-line)   preload/index.ts (contextBridge)
                                                                                            ▼
                                                                                  renderer.js (window.jarvis) — орб/чат/панели
```
- **Bootstrap** (`index.ts:876`): file-log → `clearOwnerQuit` → `registerIpc` → GSI-листенер → `createWindow` → трей →
  автозапуск (только по `JARVIS_AUTOSTART=1|0`) → `startTransport` (+Sensors, +AudioCoordinator, +sherpa-слух) → `startSidecar`
  → `setupSelection` → PTT-хоткей → `startActBridge` (loopback-мост для jarvis SDK).
- **Single-instance** (`:105`): `requestSingleInstanceLock`; второй экземпляр показывает окно первого и `app.quit()`; bootstrap только у
  владельца лока (`:874`).
- **Живёт в трее** (`:246`, `:816`): крестик = `hide()`, `window-all-closed` пуст; выход только «Выйти» в трее → `isQuitting=true` +
  `markOwnerQuit(userData)` → маркер `owner-quit.json`, хранитель `infra/client-keeper.mjs` не перезапускает до след. входа
  (`owner-quit.ts:1`); маркер снимается при каждом старте (`:878`). `before-quit` (`:918`) гасит хоткеи, оверлей, транспорт, sidecar,
  act-bridge, CDP-браузер, трей, флашит usage-profile и file-log.
- **Гварды**: `installProcessGuard` (`obs/process-guard.ts`), `wireRendererGuard` (`obs/renderer-guard.ts`: падение/зависание renderer →
  reload с бэкоффом, серия → relaunch; при потере renderer снимает «звук играет»).
- **Transport** (`transport/index.ts`): WS `ws://HOST:PORT/ws`; `client.hello{token,clientVersion,protocolVersion,resumeSessionId,installId?}`
  (`:389`); heartbeat `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_MAX_MISSES` → terminate → реконнект backoff 0.5→5 с (`:376`);
  `action.command` → дедуп по `id` пока in-flight → `executor` с дедлайном `timeoutMs` (`:536-567`) → `action.result`; оффлайн →
  `outbox` и до-отправка на open (`:594`). Коды `version_mismatch/login_required/device_revoked/subscription_required/account_blocked`
  гасят реконнект (`:85`, `:521`). `server.hello.rotatedToken` → `tokenRotated` → `device-token-store` (safeStorage).
- **Исходящие клиентские кадры**: `dev.text`, `audio.frame/vad/wake_rescue/played/playback`, `client.state/context/env/system/selection/
  settings/keys/takeover`, `user.confirm.result`, `task.control`, `demo.save`, `voice.*`, `memory.request/forget`, `client.usage.request`.
- **Сенсоры (два независимых такта)**: `Sensors` (`sensors/index.ts`, 15 с + сразу на смену) → `client.context{activeApp,fullscreen,
  micBusyByOtherApp,locked}`; `sendAmbient` (`index.ts:703`, 12 с) → `captureAmbient` (PowerShell EnumWindows + WASAPI-пик) → `client.system`
  (сводка окон/мониторов/звука + «Пользователь: за ПК/отошёл/не знаю») и питает `usageProfile.tickFocus`, `setActiveApp`, `setFullscreen`.
  `sendEnvProfile` (`:673`, TTL 6 ч) → `client.env` (браузеры, приложения, игры, реестр установленного, CLI из `TOOL_SPECS`, хоткей
  выделения, топ фокуса). Шлются на каждом `connected`.
- **Присутствие владельца**: сайдкар-хук `user-input` (LL-хуки, `InputArbiter.cs`) → `noteUserInput` (`:748`) → `noteOwnerInput` +
  `client.takeover(true)`; 1500 мс тишины → `takeover(false)`. Отличает живой ввод от синтетики (`InputSynthesizer` помечает).
- **Режим выделения**: хоткей `Control+Alt+X` (`JARVIS_SELECTION_HOTKEY`) или голос → `selectionStart` (`actuators/selection.ts:160`) →
  `SelectionOverlay.start` (прозрачные окна на всех мониторах, таймаут `JARVIS_SELECTION_DRAW_TIMEOUT_MS`) → окно шлёт `selection:done` →
  `SelectionStore.set` → `wiring` шлёт `client.selection{sel,ageMs,drawing}` (на смену, на смену фазы рисования, на коннект). Смена
  мониторов снимает осиротевшую рамку (`selectionOrphaned`). `veil-policy.ts` гейтит ввод/мышь/фокус/code_run под вуалью.
- **Настройки** (`settings-store.ts`): язык/контекст/модели — JSON в userData, ключи — `safeStorage` base64 (без шифрования — не
  сохраняются). `settingsSave` → локально + `client.settings` + `client.keys`. На реконнекте шлётся только явный локальный выбор.
- **Мониторы** (`monitors.ts`): рабочий монитор Джарвиса (деф. вторичный), окно двигается `relayout`; `displayForRect` — индексы
  синхронны с `screen_capture`.
- **Навыки демонстрацией** (`index.ts:428–515`): `demo.record` в sidecar → накопление событий → `demo.save`; реплей `runSkill` в области
  «без одобрения».
- **Renderer** (`renderer/renderer.ts`): орб/hero (idle/listening/thinking/speaking, честная подпись «микрофон выключен/нет микрофона»),
  эфемерные карточки `ui.display` (14 с), чат-режим (`chat`, `submitText` → `dev.text`), mute вывода/микрофона (localStorage
  `jarvis.muted`, `jarvis.micMuted`, `jarvis.ttsVolume`), панель настроек с 6 вкладками (Общее/Навыки/Голоса/Ключи/Память/Оплата),
  модалка §14 (`confirm-dialog.ts`, Esc = отказ), док задач (`task-panel.ts`), мониторы, модели, память, оплата. Захват/воспроизведение
  звука — `audio.ts` (зона слуха).
- **IPC-контракт**: `ipc-contract.ts` (`IPC.*` ~50 каналов) — единый источник для main/preload/renderer; `contextIsolation:true`,
  `sandbox:false`, `nodeIntegration:false`; media-permission разрешён только для аудио (`index.ts:198`).

### 1.2 Инварианты (законы, релевантные зоне)
1. Честность связи: нет сокета → `submitTypedText` говорит «фраза НЕ отправлена» (`submit-text.ts:27`), не молчит.
2. Воля владельца по микрофону (§0.6): main помнит kill-switch; запись голоса открывает гейт временно и возвращает (`restoreMicMute`, `:142`).
3. Подпись «слушаю» — утверждение (B-F4): при mute/мёртвом захвате орб показывает правду.
4. Присутствие не выдумывается: «не знаю (последний ввод — мой)» вместо «за ПК» (`:711`).
5. Выделение: свежий кадр, честная ошибка «ничего не выделено», вина отмены разведена (owner/timeout/cleared).
6. Один экземпляр; выход владельца ≠ падение (маркер).
7. Секреты: ключи только через safeStorage; renderer их не получает (`SettingsSnapshot` — флаги наличия).

## 2. Возможности
Полный машиночитаемый список — `client-shell-ui-sensors.json` (`capabilities`). Сводка по группам:

| Группа | Возможности (id) | Триггер |
|---|---|---|
| Оболочка | single-instance, tray-lives, owner-quit-marker, autostart-env, renderer-guard, process-guard, client-file-log | событие ОС |
| Связь | ws-transport, ws-heartbeat-reconnect, action-command-exec, outbox-resend, protocol-error-cards, token-rotation | сеть |
| Сенсоры | ctx-sensor (locked/fullscreen), ambient-snapshot, env-profile, usage-profile, gsi-listener, owner-presence/takeover | время/событие |
| Выделение | selection-draw, selection-hotkey, selection-orphan-clear, veil-input-gating | хоткей/голос |
| UI | orb-state, cards, chat, confirm-dialog, task-panel, settings-general/keys, memory-panel, billing-panel, model-panel, monitor-panel, voice-enroll-ui, skill-recorder-ui | ui |
| Локальные сторы | settings-store, monitor-manager, identity/device-token | ui/сервер |
| Сайдкар | ops: ground, ground.at, ui.snapshot, window.list/focus, read.*, ocr, invoke, mouse, click/type/key, demo.record, raw-input.subscribe | tool |
| Mobile | geofence→`/api/geo/event`, FCM push nudge/task.status, device register | событие телефона |

## 3. Швы (seams) и как подменять
| Шов | Файл | Как подменить в лаборатории |
|---|---|---|
| WS к серверу | `transport/index.ts` (импортирует только `ws`/`shared`/`protocol`, **без electron**) | Инстанцировать `new Transport(cfg, executor)` в обычном Node против реального сервера (`HOST/PORT` через `readEnv`). Сейчас у Transport НЕТ ни одного теста — лаборатория обязана его покрыть. |
| Клиент целиком на уровне протокола | `_jarvis_cmd.mjs`, `gateway/bench/bench-socket.ts`, `test-support/server-link.ts` | Три уровня уже есть: (a) `_jarvis_cmd.mjs` — WS-клиент только с `dev.text` (нет action.command); (b) bench-сессия — сокет вместо клиента, `action.command` → честный отказ, §14-ответы по политике; (c) `server-link.ts` — серверный `dispatchTool` → JSON → реальный клиентский `dispatch` с фейковым сайдкаром. Нет: фейкового клиента, отправляющего `client.context/env/system/selection/takeover/settings/keys` и отвечающего на `action.command` из сценария. |
| electron | `test-support/electron-mock.ts`, `fake-capturer.ts` | `vi.mock("electron", …electronModule)` (clipboard/BrowserWindow/screen/powerMonitor/desktopCapturer, масштаб DPI). `SelectionOverlay`, `monitors`, `settings-store` тестируются на подделках. |
| sidecar | `actuators/sidecar-client.ts`, `test-support/fake-sidecar.ts` | `fakeSidecarModule()` — реальные формы ответов C# + журнал вызовов. Настоящий exe: `apps/sidecar-win/smoke-test.mjs` (Windows, нужен собранный `SidecarWin.exe`). |
| Win-снимок окон/звука | `sensors/system-snapshot.ts` `runPsJson` (PowerShell) | Тестируется через `formatAmbient(wins, n)` — чистая функция; сам `enumWindows` — только на Windows. Фейк: подмена `runPsJson`. |
| Инвентарь ПК | `sensors/system-profiler.ts` (`detectApps/detectBrowsers/detectAutomationTools` принимают `exists`/`pathStr`, реестр — через PS) | DI-хуки есть (`onPath(cmd, pathStr, exists)`); `buildInstalled(raw)` чистая; реестр/железо — только Windows. |
| Часы | `UsageProfile(path, now)` — DI `now`; `Sensors.start(intervalMs)`; ambient-тик — константа `AMBIENT_TICK_MS` **без DI** | `vi.useFakeTimers()`; для `index.ts`-таймеров DI нет (они внутри Electron-entry, не тестируются). |
| GSI | `gsi-listener.ts` (HTTP 127.0.0.1:3730, env-порт/токен/stale) | Настоящий `http.request` POST в тесте — уже так (`gsi-listener.test.ts`). |
| Оверлей выделения | `SelectionOverlay` + `wiring.ts` (все Electron-примитивы — узкие функции) | `wireSelection({...fakes})` — `wiring.test.ts`. Реальные прозрачные окна — только Electron+дисплей. |
| Renderer | `window.jarvis` (preload-мост) | Подставить stub-мост и загрузить **реальный** `dist/renderer/renderer.js` в браузере — как `_design_review/_build_harness2.mjs` (лежит ВНЕ репозитория, абсолютные пути, CSP вырезается). Headless Chromium в репо уже используется (`apps/extension/test/*harness.mjs`, `infra/bench`). |
| Файлы userData | `settings-store`, `monitors`, `usage-profile`, `identity/device-token`, `owner-quit` принимают путь/каталог | tmp-каталог. `settings-store` требует `safeStorage` (мок). |
| Env-флаги | `JARVIS_HOST/PORT/CLIENT_TOKEN/CLIENT_IDENTITY/LOCAL_WAKE/AUTOSTART/DEVTOOLS/SELECTION_HOTKEY/SELECTION_DRAW_TIMEOUT_MS/GSI_*` | Для клиента без слуха: `JARVIS_LOCAL_WAKE=0`; `JARVIS_AUTOSTART` не задавать (иначе трогает реестр). |
| Mobile | `ApiClient.kt` → `/api/devices`, `/api/geo/event` | Эмулировать телефон обычным HTTP-клиентом — но **серверных роутов нет** (см. дефекты). |

## 4. Как проверять без человека
Обозначения: U — юнит/vitest уже есть; I — интеграция; S — стенд (нужно сделать); L — liveOnly.

| Возможность | Уровень | Что есть | Чем НЕ покрыто |
|---|---|---|---|
| Transport (hello/heartbeat/реконнект/outbox/dedup/timeout/NO_RECONNECT) | **нужен fake-WS-сервер в Node** | ничего (теста нет вообще; косвенно `gateway/router-ws.test.ts` со стороны сервера, `w2-server-client.test.ts` без сокета) | всё: backoff, resume, дедуп, оффлайн-outbox, ротация токена |
| Склейка `index.ts` (handlers transport→IPC, restoreMicMute, protocolError) | требует Electron или рефакторинг | `submit-text.test.ts`, `audio/mic-control` (косвенно) | 929 строк без единого теста; `lastProtocolErrorCode`, ветка `connected` |
| owner-quit / client-keeper | U + процесс | `node --test infra/client-keeper.test.mjs` (по CLAUDE.md), `owner-quit.ts` сам без теста | связка «Выйти в трее → keeper не поднимает» живьём |
| ctx-sensor `Sensors` | U | косвенно | `sensors/index.ts` сам без `*.test.ts` (emit-on-change, интервал) |
| ambient-снимок: `formatAmbient` | U | `sensors/system-snapshot.test.ts` (62 строки) | `enumWindows`/`captureAudioSources` (PowerShell) — только Windows |
| env-профиль | U частично | `sensors/system-profiler.test.ts` (`onPath`, `buildInstalled`, browser ids) | реестр/железо/steam — Windows; `sendEnvProfile` TTL |
| usage-profile | U | `sensors/usage-profile.test.ts` | flush при quit |
| GSI-листенер | U (реальный http) | `sensors/gsi-listener.test.ts` | порт-конфликт при двух клиентах |
| selection store/wiring/overlay/veil | U | `selection/{store,wiring,overlay,veil-policy}.test.ts`, `actuators/selection.test.ts`, сервер `gateway/selection-wiring.test.ts` | реальные окна на 2 мониторах, хоткей поверх игры, click-through рамки (liveOnly) |
| settings-store / monitors / identity | U | `settings-store.test.ts`, `monitors.test.ts`, `identity-store.test.ts` | `device-token-store.ts` без теста |
| renderer-логика | ограниченно | `renderer/{billing-panel,capture-starter,audio}.test.ts` (чистые функции; **jsdom нет**) | orb/cards/chat/confirm/task/memory/model/monitor/skill/voice панели — только через браузерный стенд с реальным `renderer.js` + stub-мост (S) |
| Электрон-окно, трей, GPU, автозапуск, powerMonitor, globalShortcut | **L** (Electron из песочницы агента падает на GPU; трей/хоткей/lock — только с живым сеансом Windows) | `test-support/xvfb-frames-smoke.ts` (Electron под Xvfb, облако) | трей-меню, lock-screen, автозапуск, DPI |
| Sidecar C# (UIA/OCR/окна/ввод/хуки) | **0 тестов**; `smoke-test.mjs` (ручной, Windows, exe) | форма ответов эмулируется `fake-sidecar.ts` | реальные UIA/OCR/SendInput/LL-хуки; **никакой проверки соответствия фейка настоящему C#** (drift) |
| Mobile | **L** (нужен Android + Firebase/GMS) | нет тестов | всё; серверных роутов нет |

## 5. Дефекты / долг
| Sev | Где | Что |
|---|---|---|
| high | `apps/mobile/.../ApiClient.kt:75,118` ↔ `apps/server/src` | Клиент бьёт в `POST /api/devices` и `POST /api/geo/event`; `grep "api/geo\|api/devices"` по `apps/server/src` не находит ни одного роута. Геофенс/пуш-компаньон не может работать; `apps/mobile/README` описывает несуществующий контракт. (Проверял grep — если роуты за другим префиксом/динамикой, не нашёл.) |
| high | `main/transport/index.ts` (весь) | Ядро клиент-серверного протокола (heartbeat, реконнект, outbox, дедуп, ротация токена, NO_RECONNECT) не имеет ни одного теста, хотя не зависит от Electron. |
| med | `apps/sidecar-win/*.cs` | 2800 строк C# (UIA, ввод, хуки, OCR) без единого автотеста; `fake-sidecar.ts` — рукописная копия формы, drift не ловится. |
| med | `main/index.ts:404` | `lastProtocolErrorCode` не сбрасывается на `connected`: после исправленного «Нужен вход» повторная такая же ошибка в той же сессии карточку не покажет (проглатывается как «дубль»). |
| med | `transport/index.ts:536-567` | На таймауте `withTimeout` отвечает `timeout`, но исполнение актуатора не отменяется — действие может дойти позже (клик/ввод) при том, что серверу сказано `timeout`. Закон 1 требует «неизвестно», а не «не вышло»; проверить, как сервер трактует код `timeout`. |
| med | `transport/index.ts:536,584` | Дедуп только пока команда in-flight; после доставки `inFlight.delete` — повторный `action.command` с тем же id (at-least-once после реконнекта) исполнится второй раз. Кэша завершённых нет. |
| low | `main/index.ts` (929 строк) | Нарушает «<150 строк» и не тестируется: склейка, сенсоры, навыки, трей, выделение в одном файле. `sendAmbient` держит свой таймер внутри (нет DI часов). |
| low | `sensors/index.ts:6-14,62` | Шапка утверждает «fullscreen/micBusy — TODO, дефолт false»; fullscreen уже питается из `sendAmbient`, а `setMicBusy` не вызывается нигде (мёртвый сеттер, `micBusyByOtherApp` всегда false — гейт «звонок» не работает). |
| low | `sensors/gsi-listener.ts:145` | `stopGsiListener` нигде не вызывается (нет в `before-quit`); порт 3730 освобождается только смертью процесса. |
| low | `main/index.ts:738` | `ambientTimer` не очищается при quit (unref, безвредно), `Sensors.stop()` тоже нигде не зовётся. |
| low | `main/sensors/system-profiler.ts:208` | В `TOOL_SPECS` есть `docker`, хотя на ПК владельца Docker не используется (виртуализация выключена) — может уводить модель в `code_run docker`; проверить, что при отсутствии на PATH он не попадает в профиль (детект по PATH — вероятно да). |
| low | `main/index.ts:518-575` | IPC-обработчики (`pushPcm`, `submitText`, `forgetMemory` …) не проверяют `event.senderFrame`; окно одно и грузит `file://`, поэтому риск теоретический. `sandbox:false` из-за preload `require('electron')`. |
| low | `_design_review/*` | Единственный стенд renderer'а лежит вне git, с зашитыми абсолютными путями `C:/Users/anton/...`, вырезает CSP; не воспроизводим на другой машине/в облаке. |
| low | `renderer/*` | Нет jsdom/happy-dom в `apps/client`; UI-панели (task/memory/model/monitor/skill/voice/confirm) не покрыты ничем, кроме ручного просмотра. |

## 6. Что лаборатория обязана уметь ради этой зоны
См. `labRequirements` в JSON. Главное: (1) Node-фейк клиента на протоколе (Transport + свой executor) вместо Electron; (2) headless-стенд
renderer с реальным бандлом и stub-мостом, управляемый событиями `IPC.*`; (3) фейковые часы для таймеров тактов; (4) проверка соответствия
`fake-sidecar` ↔ C# (контрактный тест / запись ответов с настоящего exe на Windows); (5) явная пометка liveOnly для трея, lock-screen, GPU,
глобальных хоткеев, прозрачных окон, sidecar UIA/OCR/hooks и mobile.
