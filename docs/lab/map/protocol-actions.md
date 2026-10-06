# protocol-actions — контракт клиент↔сервер (packages/protocol)

Снято чтением кода 2026-09-29. Только чтение; ничего не запускалось. Ссылки `file:line` — относительно `jarvis/`.
Контракт — ТОЛЬКО типы + 5 констант/функций; валидации полей в протоколе НЕТ (сервер и клиент делают `payload as X`).
Сводка: `ActionCommand` = **59 видов** (`ACTUATOR_TOOL_BY_KIND: Record<ActionKind,string>` в packages/tools/src/index.ts:71 — total-маппинг,
компилятор держит его полным), `WaitCondition` = **8 видов** (59+8 = «~67» из постановки), `MessageType` = **49 значений (29 client→server + 20 server→client)**
(packages/protocol/src/messages.ts:17-68).

## 1. КАК РАБОТАЕТ

### 1.1 Файлы
| Файл | Строк | Роль |
|---|---|---|
| src/index.ts | 53 | реэкспорт; `makeEnvelope`(:22), `newId`(:32, uuid или `id-<n>-<ms>`), `isEnvelope`(:40, структурно: id:string, type:string, "payload" in), `isProtocolCompatible`(:51, `v === PROTOCOL_VERSION`) |
| src/constants.ts | 106 | `PROTOCOL_VERSION=1`, heartbeat 15 с / 2 пропуска, `DEFAULT_ACTION_TIMEOUT_MS=15000`, `SKILL_EXECUTE_SERVER_TIMEOUT_MS=130000`, `REPLAY_TYPE_MAX_CHARS=150`, `SELECTION_MAX_WAIT_MS=120000`, `actionTimeoutMs(kind)`(:57), `FOLLOWUP_WINDOW_MS=6000`, `TARGET_FIRST_AUDIO_MS=800` |
| src/messages.ts | 625 | `Envelope`, `MessageType`, все payload-интерфейсы, `ActionResult`(:133), `ConfirmResult/Outcome`, `ActionCommandEnvelope` |
| src/actions.ts | 387 | `Target`, `ActTarget`, `ActVerb`, `ActVerify`, `ScreenRect`, `WaitCondition`, `ActionCommand`(:138) = Kind & {proactive?, origin?, approval?}, `SkillStep`, `MonitorInfo/List` |
| src/gui.ts | 96 | `FrameId`, `CommitGrant`, `CommitApproval`, `NeedsApproval`, `CaptureData`, `OcrData`, `AppLaunchWindow` |
| src/wake-rescue.ts | 25 | `WakeRescue`, `WakeRescueResult` |
| src/constants.test.ts | 41 | ЕДИНСТВЕННЫЙ тест пакета: таблица `actionTimeoutMs` (18 видов) + 2 инварианта |

### 1.2 Конверт и транспорт
* Один WS `ws://host:8787/ws`, каждый кадр = JSON-строка `Envelope{id, ts, type, payload}`. Бинарных кадров нет: аудио (PCM/TTS) — base64 внутри JSON.
* Клиент: `apps/client/main/transport/index.ts` (Transport). Сервер: `gateway/server.ts` (handshake) → `gateway/router-ws.ts:dispatch` (:936, switch по `type`) + `gateway/session.ts` (Session).
* **Handshake** (server.ts:774-1020): открыт сокет → 5 с (`HANDSHAKE_TIMEOUT_MS`, :106) на первый кадр `client.hello`, иначе `error{unauthorized}`; кадры до конца handshake копятся в `PreHandshakeBuffer` (600 кадров/4 МиБ) и реплеятся. Мажор не совпал → `error{version_mismatch}` + close 4002. Продуктовый режим: `resolveHello` → отказ `login_required/subscription_required/device_revoked/account_blocked` + close 4003; иначе `resolveAndProvision(token)` (на loopback токен = ключ раздела, не auth). Успех → `server.hello{sessionId, protocolVersion, resumed, [productMode,user,rotatedToken]}`.
* **Resume**: `Hello.resumeSessionId` → `registry.createOrResume`; обрыв сокета → сессия живёт `RESUME_GRACE_MS=120 с` (registry.ts:15), in-flight команды сохраняются (`Session.rebind`, session.ts:104).
* **Heartbeat**: сервер шлёт envelope `ping{ts}` каждые 15 с, ждёт envelope `pong`; 2 пропуска → close 4000 (heartbeat.ts). Клиент параллельно шлёт ws-уровневый ping + envelope `ping` (transport:402-416), сервер отвечает `pong`. Клиент на server-`ping` отвечает `pong` (transport:457).
* **Реконнект клиента**: backoff 500 мс..5 с, `resumeSessionId` из последнего `server.hello`; НЕ реконнектится после `error` с кодами version_mismatch/login_required/device_revoked/subscription_required/account_blocked (NO_RECONNECT_CODES, transport:85,524).
* **Error-кадр** сервера: `{id:"", ts, type:"error", payload:{code,message}}` (server.ts:1161) — id пустой, не uuid.

### 1.3 Цикл ActionCommand → ActionResult (ядро контракта)
1. Сервер: инструмент LLM → `KIND_BY_TOOL` (tools/dispatch.ts:383) → `commandFromInput` (tools/command-fields.ts, allowlist полей по JSON-схеме инструмента; `gui.act.steps` вырезается) + серверные поля `origin` ("user"|"proactive") и `approval` (CommitApproval после «да» владельца) → `sendActionApproved` (send-approved.ts) → `Session.sendAction(cmd, actionTimeoutMs(kind))` (session.ts:140).
2. Конверт: `type:"action.command"`, `id = commandId` (uuid), `payload = {...cmd, timeoutMs}` (session.ts:276). `timeoutMs` обязателен по типу `ActionCommandEnvelope`(messages.ts:625), но клиент терпит его отсутствие (дефолт 15 с, transport:541).
3. Fail-fast: сессия закрыта → `{ok:false,error:{code:"disconnected"}}` сразу; сокет не OPEN (resume-grace) → `channel_down` сразу (session.ts:145-155); иначе таймер `timeoutMs` → синтетический `{code:"timeout",message:"нет result за Nms"}` (unref-нутый).
4. Клиент: `handleActionCommand` (transport:536) — дедуп по commandId (повторный кадр игнорируется), `Promise.race(executor, таймер timeoutMs)`; таймаут → `{code:"timeout", durationMs:timeoutMs}`; исключение → `runtime`. Executor = `serverExecutor(dispatch)` (actuators/approval-scope.ts): открывает ALS-область `via:"server"` с `approval` из конверта — рубеж §14 читает одобрение ТОЛЬКО оттуда.
5. Клиентский `dispatch` (actuators/index.ts:211): вуаль-гейт (`overlay_drawing`) → гейт присутствия только при `origin==="proactive"`/`proactive===true` (`denied` "USER_BUSY…") → снимок UIA «до» (`needsBeforeSnapshot`) → switch по kind (:294) → `okResult/errResult`. Исключения с полями `actionCode/actionData/injected` (action-error.ts) превращаются в код + `data` + `stepActionInjected`; любые другие → `runtime`.
6. Результат: `action.result` с `payload=ActionResult{commandId, ok, error?{code,message}, data?, stepIndex?, stepActionInjected?, durationMs}`. Оффлайн — в outbox, переотправка после реконнекта (at-least-once). Сервер `Session.resolveAction` (session.ts:173): поздний/дублирующий результат (in-flight уже снят по таймауту) молча игнорируется.
7. `dispatch()` дополняет `data.overlayDrawing:true` (и `unknown:true` для wait.for) когда результат снят под вуалью режима выделения (index.ts:225-230).

**Коды `ActionResult.error.code`**: `timeout` (сервер И клиент), `not_found`, `denied`, `runtime`, `overlay_drawing` (клиент); `disconnected`, `channel_down` (только сервер, синтетика). `denied` бывает двух видов: USER_BUSY (без data) и рубеж §14 (`data.needsApproval: NeedsApproval`).
**`stepActionInjected:true`** = часть действия уже ушла в GUI, исход неизвестен → сервер: uncertain, без повтора (закон честности №1). **`stepIndex`** — номер шага skill.execute / число выполненных действий скрипта при остановке вуалью.

### 1.4 Одобрение §14 (CommitApproval / NeedsApproval / CommitGrant)
* Клиентский рубеж (inject.ts) не нашёл гранта → `ActionResult{ok:false,error.code:"denied",data:{needsApproval:{category,process,hwnd?,windowTitle?,what,signature,pendingText?}}}`.
* Сервер (`send-approved.ts:31 needsApprovalOf`) строит вопрос САМ (категорию пересчитывает, строки с экрана чистит), шлёт `user.confirm.request{requestId,summary,kind:send|order|irreversible,expiresAt}`; «да» → `ConfirmResult{approved:true}` → повтор ОДНОЙ команды с `approval{grants:[{signature,process,hwnd?,host?,count}], expiresAt}`; повторный needsApproval → честный отказ (третьего вопроса нет).
* `ConfirmResult.outcome` (`approved|denied|expired|undelivered|deferred`) клиент НЕ шлёт — заполняет сервер (мёртвый канал → `undelivered` мгновенно, окно истекло → `expired`; deferred в Ф0 не выдаётся). Клиент шлёт только `{requestId, approved, revision?}`.

### 1.5 Таймауты по виду (`actionTimeoutMs`, constants.ts:57; тест — constants.test.ts)
| kind | мс | инвариант |
|---|---|---|
| skill.execute | 130 000 | строго > клиентского бюджета реплея (80 с, кламп env `JARVIS_SKILL_REPLAY_BUDGET_MS` 10..80 с) + хвост шага ≤~33 с |
| wait.for | 130 000 | клиентское ожидание до 120 с |
| gui.act | 60 000 | > клиентского `ACT_BUDGET_MS` 45 с (act.ts) |
| fs.search | 60 000 | > клиентский бюджет 40 с |
| app.launch | 36 000 | hard-25 с лаунчера + ожидание окна ≤5 с |
| fs.view | 30 000 | |
| input.click/type/mouse/key, ui.invoke | 30 000 | лестница UIA ≤12 с + fused-наблюдение ~6.4 с |
| screen.ocr, screen.selection | 25 000 | (selection start c waitMs считает потолок сам: waitMs+15 с, кламп 120 с) |
| ui.snapshot, app.close, app.focus, browser.open | 20 000 | |
| ВСЕ ОСТАЛЬНЫЕ | 15 000 | window.list, fs.*, system.*, screen.capture/probe, monitor.* … |
Отклонения вызывающих (не через функцию): job.status 20 с (handlers/code-job.ts:17), jbrowser.import_cookies 30 с, telegram.send 90 с, jbrowser.read 15 с, ext-мост 30 с (server.ts:477).

### 1.6 Инварианты (нельзя ломать в лаборатории)
1. Ровно один `action.result` на каждый `action.command` (корреляция по `commandId = envelope.id`), `durationMs` обязателен.
2. Серверный потолок СТРОГО выше клиентского внутреннего бюджета, иначе успешное действие рапортуется таймаутом и ретрай модели его дублирует.
3. Ложного `ok:true` нет: провал → `ok:false`; «ушло, но не знаю» → `stepActionInjected`; фейковый клиент НЕ вправе отдавать `ok:true` без выполнения (закон №1; см. комментарий _jarvis_cmd.mjs:59-68).
4. `approval` ставит только сервер; клиент читает только из ALS-области серверной команды.
5. Мажор `protocolVersion` равен — иначе close 4002 без реконнекта.
6. Dev/лаб-клиент обязан назвать `clientVersion` по regex `/cmd|test|driver|qa|smoke|probe|bench|script/i` (gateway/dev-session.ts:22), иначе он «съест» одноразовые ресурсы владельца (онбординг, сон-цикл, доклад о сбоях, сводку дня, ambient, отложенные напоминания).
7. Координаты/кадры: `frame` (`<bootTag><f|z|o|s><n>`, LRU 64) — координаты только внутри кадра, чужой/устаревший → `not_found` «кадр устарел»; `space:"screen"` — только SDK/реплей.

## 2. ВОЗМОЖНОСТИ (полный перечень — см. JSON; здесь сжато)

### 2.1 Сообщения клиент → сервер (обработчик — router-ws.ts:dispatch)
| type | payload | эффект на сервере |
|---|---|---|
| client.hello | Hello{token,clientVersion,protocolVersion,resumeSessionId?,installId?} | handshake; installId только при токене `jdt_` |
| dev.text | {text} | ход как от голоса (onDevText :1170) — ОСНОВНОЙ вход лаборатории |
| audio.frame | {pcm:base64 string,sampleRate,seq} | в VoicePipeline либо в enrollment; сервер принимает string/ArrayBuffer/number[]/TypedArray (toArrayBuffer :1302) |
| audio.vad | {state: speech_start\|speech_end\|barge_in\|wake_local\|speech_cancel} | onVadEvent |
| audio.wake_rescue | WakeRescue{pcm b64,sampleRate,ms,peak} | routeWakeRescue; **отбрасывается, если `Date.now()-env.ts > 6000`** (wake-rescue-route.ts:13) и во время enroll; ответ `wake.rescue.result` только при принятии |
| audio.played / audio.playback | {gen,ts,seq} / {active} | mouth-to-ear метрика / дренаж очереди озвучки по факту звука |
| action.result | ActionResult | Session.resolveAction |
| user.confirm.result | ConfirmResult | Session.resolveConfirm |
| client.context / .env / .system / .selection / .settings / .keys / .state / .takeover / .usage.request | см. messages.ts | контекст хода, профиль, ключи (шифруются), пауза задачи при takeover |
| task.control | {action: cancel\|pause\|resume\|status, taskId?} | handleTaskControl |
| memory.request / memory.forget | {query?} / {layer,id,query?} | ответ `memory.state` |
| voice.enroll.start/cancel, voice.list, voice.remove | {name}/… | ответы voice.enroll.progress/done, voice.voices |
| demo.event / demo.save | DemoEvent / DemoSave | event — только лог; save → навык + `skill.saved` + `ui.display` |
| screen.capture.result | — | ТОЛЬКО лог (router-ws.ts:1136), мёртвый тип |
| pong, ping | | heartbeat |

### 2.2 Сообщения сервер → клиент
server.hello, speak.chunk (`audio` base64, `seq,last`, `format:"pcm16"+sampleRate` или mp3, `gen`), transcript{text,final}, chat{role,text}, action.command, user.confirm.request, task.status (TaskStatus), ui.display (DisplayCard), skill.saved, usage.info, models.catalog, memory.state, voice.enroll.progress/done, voice.voices, wake.rescue.result, client.state{state} (**сервер тоже шлёт** — орб/аудио-гейт; в MessageType помечен client→server), error, ping. НЕ отправляются сервером нигде: `proactive.nudge` (клиент умеет принять), `screen.capture.request`.

### 2.3 59 видов ActionCommand и форма `ActionResult.data` (по клиентскому диспетчеру; «—» = data отсутствует)
Тип команды — actions.ts:N; исполнение — actuators/index.ts:M. Ошибки: `not_found` только там, где написано; иначе `runtime`.

**Приложения / окна / звук**
| kind (actions:index) | ключевые поля | data при ok |
|---|---|---|
| app.launch (233:296) | app | `LaunchOutcome`: {resolved, pid?, display?, kind?, source?, confirmed?, verified?, note?, window?{hwnd,title}, windowSeen?} |
| app.focus (234:300) | app | {resolved, focused:true}; focused=false → `not_found` |
| app.close (238:314) | app, force? | {resolved, closed:N}; closed=0 → `not_found` |
| browser.open (239:332) | url, inDefault? | inDefault: {...LaunchOutcome,url,controlled:false,inDefault:true}; иначе CDP {url,controlled:true} или откат {...launch,controlled:false} |
| window.list (210:416) | — | {windows:[{hwnd,pid,process,title,foreground,minimized,monitorIndex,monitor,rect{x,y,w,h}}]} |
| window.focus (213:420) | hwnd?/query? | {focused:true,hwnd,title,monitorIndex?,monitor?} (+`via:"AppActivate"` при откате); провал → `runtime` |
| window.arrange (217:451) | hwnd?/query?, op: minimize\|maximize\|restore\|move, monitor?, maximizeAfterMove? | {hwnd,minimized,maximized,rect,monitorIndex\|null,monitor,title,process}; окно не найдено → `runtime` |
| audio.sessions (228:478) | — | {sessions:[{pid,process,title,state:active\|inactive,muted,volume 0..1,peak 0..1}]} |
| audio.set (232:483) | pid?/process?, mute?, level? | {touched:N, sessions:[{pid,process,muted,volume}]}; нет сессии → исключение `runtime` |

**Ввод / GUI-руки**
| kind | ключевые поля | data |
|---|---|---|
| input.type (150:353) | text | `{observation}` или undefined |
| input.key (151:359) | combo, mode: press\|down\|up, scancode? | `{observation}`; для down/up — undefined |
| input.click (161:366) | target, method: silent\|physical, button?, count? | `{screenX,screenY,pressed?,observation?}` для coords-целей; для handle/role — только `{observation}` или undefined |
| input.mouse (164:383) | op: move\|down\|up\|wheel\|drag, x,y,toX,toY,button,dx,dy,space,frame | `{op, observation?}` (observation для drag/wheel/up) |
| ui.invoke (177:402) | target, pattern, value? | `{observation}` или undefined; setValue без value → `runtime` |
| ui.ground (205:407) | query{role,name?,nameMode?,automationId?} | GroundResult {handle:string, bbox{x,y,w,h} ФИЗ.px, name?, role?"ControlType.X"} |
| ui.snapshot (208:411) | pid?, maxItems?, frame? | {window,pid,items:[{handle:**number**,role,name,automationId?,value?,x,y,w,h}],truncated,frame?} (bbox — в кадре) |
| gui.act (186:396) | target?(ActTarget), app?, do?, text?, combo?, verify?, physical?, clear?, enter?, to?, dx?, dy?, observe? | `ActOutcome`: {found?{via,name,role,handle,note,query?}, focused?, did, physical, screenX?, screenY?, verified:"met"\|"failed"\|"unchecked", detail, observation?}; частичное исполнение → `runtime`+`stepActionInjected` |
| context.read (263:659) | scope: selection\|active_window\|screen | {scope, text} (text может быть "" — не ошибка) |

**Экран**
| kind | поля | data |
|---|---|---|
| screen.capture (256:623) | monitor?, rect?, scale?, maxEdge?, maxPixels? | ScreenShot {image b64 PNG, mediaType:"image/png", width, height, frameId?, zoomOf?} (CaptureData) |
| screen.ocr (258:636) | monitor?, rect?, lang?, frame? | OcrData {text, lines:[{text,x,y,w,h}], width,height, frameId, frame?, mapping?} |
| screen.probe (260:641) | rect?, monitor? | {hash 64-bit hex, mean 0..255, width, height} |
| screen.selection (270:645) | op: start\|view\|clear, waitMs?, scale?, force? | start: {started, selection?, cancelled?, cancelReason?, timedOut?, overlayOpen?, waitedMs?, reused?, failed?, failReason?}; view: {image,mediaType,width,height,selection,ageMs\|null,changedSinceSelection?,frameId?}; clear: {cleared,drawCancelled}; нет выделения → ошибка |
| wait.for (262:653) | condition(WaitCondition), timeoutMs?, pollMs? | WaitOutcome {met, elapsedMs, polls, detail, veiled?, gsiState?, unknown?}; met:false по таймауту = `ok:true` (честное «не наступило»), НЕ ошибка |

**WaitCondition (8 видов, actions.ts:85-112)**: `ui{role,name?,nameMode?,gone?}`, `window{titleContains?,process?,gone?}`, `text{text,monitor?,rect?,gone?}` (OCR), `sound{playing}` (WASAPI peak), `gsi{source?,path,equals?,contains?,gone?}` (локальный GSI-листенер клиента), `file{path,gone?,minBytes?,stableMs?}`, `process{pid?,name?,gone?}`, `browser{prop?,op?,value,selector?,tabId?,url?,gone?}` — **browser вычисляется НА СЕРВЕРЕ** (tools/dispatch.ts:~715, `waitForBrowserTool`), клиенту не уходит.

**Код / навыки**
| kind | поля | data |
|---|---|---|
| code.run (244:494) | lang: python\|node\|powershell, code, cwd?, timeoutMs?(кламп 1..180 с), background? | sync: CodeRunResult {stdout,stderr,exitCode:0,truncated,timedOut?,stdoutTail?}; ненулевой exitCode → **`ok:false` runtime** (или `overlay_drawing` + stepIndex/stepActionInjected); background: {jobId,pid,cwd,logDir,startedAt,background:true,note}; python-скрипт, перехвативший вуаль → ok + {overlayCaught,overlayReason,note} |
| job.status (245:540) | jobId, kill? | CodeJobStatus {jobId,lang,cwd,running,exitCode?,elapsedMs,stdoutTail,stderrTail,overlayMarker?} (+overlayStopped/overlayReason/overlayDone/overlayInjected/overlayCaught/note) |
| skill.execute (246:583) | skillId, version, steps:SkillStep[], params? | успех: undefined или `{observation, veiled?}`; провал: `ok:false`, `stepIndex`, `stepActionInjected?`, код runtime/denied(+data.needsApproval)/overlay_drawing |
| demo.record (271:664) | op | ВСЕГДА `runtime` "not implemented (M4)" |

**Файлы** (все ok-данные — объекты; ошибки FS → `runtime`)
fs.read (287:716) → ReadResult {path,content,bytes,truncated,encoding,note?,totalLines?,range?{from,to}}; fs.write (288) → {path,bytes,created}; fs.edit (289) → {path,replacements,bytes}; fs.append (290) → {path,bytes}; fs.list (291) → {path,entries:[{name,path,type:file\|dir\|other,size}],truncated}; fs.delete (292) → {path,deleted}; fs.move (293) → {from,to}; fs.mkdir (294) → {path}; fs.search (296:733) → {matches[],ignoredDirs,ignoredNames[],truncated,stopReason?,…SearchGaps}; fs.view (299:617) → FileViewResult {path,image b64,mediaType png\|jpeg\|gif\|webp,width?,height?,format,bytes,page?,pageCount?,resized,rendered?,note?}. Защита: секреты (.env и т.п.), защищённые деревья — отказ.

**Система / офис / OBS / мониторы**
system.lock (301) → {ok:true}; system.power (302; shutdown/restart с задержкой + окно отмены, `cancel` без confirm) → {ok:true}; system.media (303; `state` → {ok,playing,peak,already?}); system.volume (304: get/set/up/down → {ok,level?}; mute → {ok,muted}); system.clipboard (305: read → {ok,stdout}; write → {ok}); system.layout (306) → {ok,stdout?}; office.excel (312:746) / office.word (322:748) → JSON из COM-скрипта `{ok:true,op,…(text для read / cells…)}` (`ok:false,error` внутри → исключение runtime); obs.request (329:752) → ответ obs-websocket v5; monitor.set (308:756) → {target,summary}; monitor.list (309:760) → MonitorList {monitors:[{index,label,width,height,isPrimary,isJarvis}], jarvisIndex\|null}; monitor.assign (310:763) → MonitorList, индекс вне диапазона → `runtime`.

**Мессенджеры / браузер Джарвиса / заказ**
message.send (272:666; channel vk\|telegram; §14 confirm+cadence на сервере) → {messageId?}; telegram.send (275:671) → {delivered,chatTitle,peerId?}; telegram.read (276:677) → {chatTitle,messages:[{dir:in\|out,text}]}; jbrowser.open (278:682)/jbrowser.read (279:686) → PageContent {title,url,text,loginWall?}; jbrowser.inspect (280:690) → инвентарь элементов (unknown-форма); jbrowser.act (281:694; intent click\|type\|scroll\|key\|upload) → Record; jbrowser.login (282:698) → {opened:url}; jbrowser.import_cookies (283:704) → {set,total}; order.place (284:709) → **ВСЕГДА `runtime`** "не реализован (M7)" (browser.ts:26-36).

### 2.4 Что клиент НЕ исполняет из протокола
`demo.record`, `order.place` — заглушки-провалы. `browser.act/browser.read` удалены из протокола (W1, B-12): руки во вкладках — через расширение (`/ext` мост, вне packages/protocol; свой контракт — apps/server/src/gateway/extension-bridge*). Транспортные типы `proactive.nudge`, `screen.capture.request/result`, `MessageType` "audio.frame" (dev-путь) — рудименты.

## 3. ШВЫ
| Шов | Где | Как подменить |
|---|---|---|
| Сокет сессии | `SessionSocket` (gateway/session.ts:26: send/close/readyState) | уже есть: `BenchSocket` (gateway/bench/bench-socket.ts) — НО отвечает на любой action.command честным отказом и на confirm по политике; для лаборатории нужен «фейковый клиент ПК» вместо refuseAction |
| Реальный WS-клиент | `_jarvis_cmd.mjs` (текст), `_jarvis_voice.mjs`, `_qa_battery.mjs`, `infra/bench/client.mjs` (HTTP к dev-эндпоинтам) | клиентские драйверы отвечают `action.result ok:false` — не годятся как «рабочий стол» |
| Исполнитель клиента | `CommandExecutor` (transport:91) = `serverExecutor(dispatch)` | подставить свой executor в `new Transport(cfg, executor)` или использовать `dispatch` с моками |
| Сайдкар (UIA/OCR/ввод) | `actuators/sidecar-client.ts` | `apps/client/main/test-support/fake-sidecar.ts` (реальные формы ответов C#: handle числом, `ControlType.X`, окна в z-порядке) |
| Захват экрана / electron | `test-support/fake-capturer.ts`, `electron-mock.ts` | `vi.mock("electron", …fakeElectronModule())` |
| Стык сервер↔клиент в одном процессе | `test-support/server-link.ts` | настоящий серверный `dispatchTool` + настоящий клиентский `dispatch` в ALS-области, JSON-туда-обратно, фейки только на краях (сайдкар, захват, владелец) |
| Часы | `Date.now()` (envelope.ts, expiresAt, RESCUE_MAX_AGE_MS 6 с, resume-grace 120 с, heartbeat) | единого шва часов нет; heartbeat/`scheduleRemove` принимают интервал параметром (`startHeartbeat(session,onDead,intervalMs,maxMisses)`, `scheduleRemove(id,graceMs)`); остальное — vi.useFakeTimers |
| Мозг | `agentDeps.llm` | `ScriptedLlm` (gateway/bench/scripted-llm.ts) или реальный (подписка) |
| Dev-HTTP | `JARVIS_DEV_HTTP=1`: `POST /dev/action` (команда в подключённый Electron), `/dev/say`, `/dev/bench/*` | server.ts:477 (`sendAction(cmd,30_000)`) |
| Версия/идентичность | `Hello.clientVersion` (regex dev-сессии), `Hello.token` | лаб-клиент: `clientVersion:"lab-test"` |
| Аудио | `audio.frame` base64 PCM16 mono, `audio.wake_rescue`, `speak.chunk` | записанный звук → кадры; TTS-чанки лаборатория может считать (BenchSocket считает `speakChunks`) или декодировать |

## 4. КАК ПРОВЕРЯТЬ БЕЗ ЧЕЛОВЕКА
| Область | Достаточно | Нужно | Уже есть | НЕ покрыто |
|---|---|---|---|---|
| actionTimeoutMs | юнит | — | packages/protocol/src/constants.test.ts | связь с клиентскими бюджетами (act 45 с, replay 80 с, fs.search 40 с) — только комментарии; нет теста «серверный > клиентский» |
| Session.sendAction/timeout/channel_down/disconnected/confirm outcomes | интеграция | fake-clock | apps/server/src/gateway/session.test.ts, registry.test.ts | синтетика на реальном WS |
| Handshake / version_mismatch / pre-handshake буфер / H7 | интеграция с реальным WS | — | gateway/handshake-h7.test.ts, pre-handshake-buffer.test.ts, ws-routes.test.ts, bind.test.ts | клиент Transport: **тестов нет вообще** (apps/client/main/transport/ — только index.ts) — ни реконнект, ни outbox, ни дедуп commandId, ни NO_RECONNECT_CODES |
| makeEnvelope/isEnvelope/isProtocolCompatible/newId | юнит | — | — | **не покрыто** |
| Диспетчер клиента ↔ сервер (все виды) | fake-sidecar + fake-capturer | — | actuators/*.test.ts (dispatch-honesty, frames-dispatch, act-*, fs*, system*, office*, obs*, screen-*, selection*, windows*, audio-sessions*, code-runner*), test-support/server-link.ts (+ gui-approval-w2.test.ts, rubezh-*.test.ts) | форму `data` каждого из 59 видов сверяет только частично; единой таблицы «kind → схема data» нет |
| §14 needsApproval-цикл | server-link | fake owner | tools/send-approved (approval-loop.test.ts, gui-approval-w2.test.ts, commit-gate-dispatch.test.ts) | |
| Полный WS-цикл «сервер + клиент-эмулятор с реалистичным рабочим столом» | fake-desktop клиент | fake-desktop | **отсутствует** (BenchSocket/драйверы только отказывают) | ← главный пробел лаборатории |
| wake_rescue | интеграция | audio-replay + облачный STT (real/fake) | gateway/wake-rescue-wiring.test.ts | 6-секундный возраст по env.ts (Date.now), реальный STT |
| audio.frame → VoicePipeline | audio-replay | fake STT/VAD | voice/*.test.ts (вне карты) | |
| skill.execute / SkillStep | fake-desktop | fake-sidecar | skill-runner тесты, rubezh-replay.test.ts | |
| wait.for gsi/file/process/browser | fake-desktop + fake-clock | | wait-file-process.test.ts, browser-condition.test.ts | gsi живой листенер |
| liveOnly (нужно железо/владелец) | | | | реальный UIA/SendInput/WASAPI/COM Office/OBS/оверлей выделения/мониторы/Electron GPU; голос; реальные Chrome-профиль (jbrowser); Telegram/VK userbot; shutdown/restart/logoff; OCR Windows.Media.Ocr |

## 5. ДЕФЕКТЫ / ДОЛГ
| Сев. | Где | Что |
|---|---|---|
| med | messages.ts:125-131, 349-361 vs transport:207 и router-ws.ts:749 | `AudioFrame.pcm` и `SpeakChunk.audio` типизированы как `ArrayBuffer`, а по проводу идёт base64-строка (JSON). Автор фейкового клиента, идя по типам, пошлёт неверное; сервер терпит 4 формы (toArrayBuffer :1302), клиент — только строку. |
| med | messages.ts:26,47 vs router-ws.ts:762 | `client.state` перечислен в разделе client→server, но сервер тоже шлёт его клиенту (`sendClientState`) — двунаправленный тип без пометки. |
| med | transport/index.ts:536-575 | Таймер клиента = тот же `timeoutMs`, что и серверный; при срабатывании клиент шлёт синтетический `timeout`, а актуатор НЕ отменяется (Promise.race) — действие может дожить и выполниться после того, как сервер уже объявил timeout. Смягчено лишь тем, что потолки видов выше внутренних бюджетов. |
| med | constants.ts:8, config.ts:101, server.ts:914-921 | `config.protocolVersion` переопределяется env `PROTOCOL_VERSION`, но совместимость проверяется по константе `PROTOCOL_VERSION`, а `server.hello` отдаёт config-значение → расхождение при переопределении. |
| med | apps/client/main/transport/ | Нет ни одного теста Transport (реконнект, outbox, дедуп, heartbeat, NO_RECONNECT_CODES) — центральный шов без покрытия; нет и тестов на `index.ts` протокола. |
| low | messages.ts:53-54,66, router-ws.ts:1136 | Мёртвые типы: `proactive.nudge` (сервер не отправляет; клиент принимает), `screen.capture.request` (нигде), `screen.capture.result` (только лог), интерфейсы `ScreenCaptureRequest/Result`, `AudioFrame` как «dev-заглушка до LiveKit». |
| low | actions.ts:271,284; index.ts:664; browser.ts:26 | `demo.record` и `order.place` объявлены в контракте, но клиент всегда отвечает `runtime` (заглушки M4/M7; order_place ещё и в EXCLUDED_TOOLS). Лаборатория не должна считать их возможностями. |
| low | actions.ts:24 vs ground.ts:23/79 | `Target.handle: string`, но `ui.snapshot.items[].handle: number` (реальный сайдкар); `GroundResult.handle: string` получается приведением (`asGroundResult`) — тип контракта не описывает форму `data` вообще (`ActionResult.data: unknown`), форму приходится реверсить из актуаторов. |
| low | messages.ts:133-156 | `ActionResult.data: unknown` — 59 форм нигде не задекларированы типами; гейт-поля (`observation`, `needsApproval`, `overlayDrawing`, `veiled`, `unknown`, `frameId`) — неявный контракт. |
| low | server.ts:1161 | `error`-кадр имеет `id:""` (не uuid, не коррелируется). |
| low | router-ws.ts:936-1160 | Все `env.payload as X` без проверки; битый payload (undefined) даст TypeError, который глотается `.catch` в server.ts:865 (логируется, сессия жива). |
| low | dev-session.ts:22 | Регэксп dev-сессии широк (`test`, `script`, `probe`…): реальная сборка клиента с такой подстрокой в версии тихо перестанет получать онбординг/доклады. |
| low | messages.ts:498-499 | Висящий JSDoc «Продуктовый режим (квоты плана)…» без поля перед `credits` (дубль-остаток). |
| info | constants.ts:103-106 | `FOLLOWUP_WINDOW_MS`, `TARGET_FIRST_AUDIO_MS` — потребляются вне протокола; проверять на актуальность отдельно. |

## 6. ТРЕБОВАНИЯ К ЛАБОРАТОРИИ
1. **Фейковый клиент ПК по WS** (`lab-test` clientVersion): реальный `Hello` → `server.hello`, ответ `pong` на `ping`, ответ `action.result` на КАЖДЫЙ `action.command` с реалистичной формой `data` из п.2.3, честными ошибками (`not_found/denied/runtime`) и `stepActionInjected`; управляемый сценарием (успех/провал/таймаут/молчание/`channel_down` через обрыв сокета).
2. **Виртуальный рабочий стол** под этим клиентом: окна (hwnd/pid/process/title/z-order/мониторы), UIA-дерево с handle-числами, буфер обмена, файловая система в песочнице, аудио-сессии, громкость, кадры (`frameId` по схеме bootTag+kind+n, LRU 64) с проверкой координат; проще всего — переиспользовать `fake-sidecar.ts` + `server-link.ts` за WS-обёрткой.
3. **Цикл §14**: генерация `denied+needsApproval` рубежом, приём `user.confirm.request`, ответы approved/denied/expired/undelivered, проверка повтора с `approval.grants` (счётчики, hwnd/host, expiresAt).
4. **Управляемые часы**: `Date.now`/таймеры для `timeoutMs`, resume-grace 120 с, heartbeat 15 с, `RESCUE_MAX_AGE_MS`, `expiresAt`; проверка «серверный потолок > клиентский бюджет» как автотест над таблицей.
5. **Контрактный набор**: по одному тесту на каждый из 59 видов — форма `data` против единой JSON-схемы (нужно ввести), плюс обязательный `durationMs`, ровно один result на команду, отсутствие ложного `ok:true`; тесты Transport (реконнект+resume+outbox+дедуп).
6. Аудио-вход: запись PCM16 → `audio.frame`/`audio.vad`/`audio.wake_rescue` (с правильным `env.ts`), приём `speak.chunk` (base64, mp3 или pcm16+sampleRate) с подсчётом/декодированием, `audio.played`/`audio.playback` для замера mouth-to-ear.
