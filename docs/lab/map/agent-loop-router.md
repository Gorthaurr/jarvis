# Карта лаборатории: agent-loop-router

Область: `apps/server/src/brain/agent/*` (+`loop/*`), `brain/router/*`, `brain/tasks/*`, `brain/persona/*`. Один ход от текста до финала. Все пути ниже — от `apps/server/src/brain/`. Прочитано целиком: `agent/index.ts`, `turn-intercepts.ts`, `presence.ts`, `sync-promote.ts`, `loop/{step,admission,context,config,guards,tiering,model-call,nudge-policy,tool-round,post-round,text-turn,terminal,outcome,finalize,anti-runaway,retrieval,prompt,convo,tool-set,thinking,stream-final,ack-timer,input-lease,tool-ctx,checkpoint-save}.ts`, `state.ts` (первые 140 строк), `tasks/{manager,control}.ts` (основное), `router/index.ts` (classifyTier, matchLocalIntent). Не читал построчно: `checkpoint.ts` (710 строк — только экспорты), `error-voice.ts`, `tool-classify.ts`, `family-count.ts`, `scope.ts`, `narrate.ts`, `persona.md` — по ним записи ниже опираются на сигнатуры/комментарии.

## 1. Как работает

### 1.1 Сквозной поток одного хода
```
голос: pipeline → onUserTurn/onUserTurnStream (gateway/router-ws.ts:727,740) ── handleControlUtterance («отмени/пауза/вырубись», $0) ─┐
текст: onDevText (router-ws.ts:1168) ── handleControlUtterance ───────────────────────────────────────────────────────────────────────┤
                                                                                                                                       ▼
handleUserText (agent/index.ts:50)
 1 cleanDisfluency → memory.pushTurn("user") → noteOwnerTurn (грант «поручение=разрешение», index.ts:85)
 2 activeTask = tasks.activeForUser(userId, dev) ; freshContext = machineTurn || classifyTaskScope(clean, active.goal)==="new"   (:100-107)
 3 TURN_INTERCEPTS по порядку (turn-intercepts.ts:441): name → notForMe → presence → mode → emotion → activeTask(дубль-гейт lex+e5, steer)
   → fireReflexes(факты/обязательства, fire-and-forget) → clarify(ответ консьержу) → echoGate(90 с после терминала) → resume(«доделай»)
   первый вернувший AgentReply закрывает ход
 4 classifyTier(clean) (router/index.ts:189) + confirmationAware (index.ts:222: «да» после вопроса Джарвиса ≤5 мин → sonnet-действие)
 5 tier0+local: clarify → мгновенный вопрос; иначе runTier0 (index.ts:252) → runLocalIntent (:584) → session.sendAction(ActionCommand)
   fallbackToLlm (app.launch не нашёл / вуаль overlay_drawing / selection.clear без рамки) → tier="sonnet" + priorFailure врезкой
 6 кэш ответов: responseCache.lookup — ТОЛЬКО conversational && !selection && !reaction (index.ts:159)
 7 действие (sonnet/fable, не conversational):
     • есть speakResult и sink → runActionSyncFirst (:392): слот семафора tryAcquire; петля с wrap-sink; promoteRace (sync-promote.ts:28):
       промоушен по ПЕРВОМУ tool_use (пол 1,5 с) или по капу 6 с → sink.done(«Берусь», ack) + фон, итог через speakResult
       слотов нет → bounded-фон (queuedPreTask :344 → state queued)
     • есть speakResult без sink (dev.text/чат/бенч) → тихий фон startBackgroundTask (:351), reply.voice="" ; итог приходит speakResult
     • нет speakResult (юнит-тесты) → синхронно runAgentLoop
 8 разговор (вопрос/реакция/трёп) → runAgentLoop синхронно со стримом в sink
```

### 1.2 runAgentLoop (index.ts:509) и фазы
`createLoopState` (loop/state.ts: группы tier/exit/budget/honesty/nudge/progress/usage/arsenal) → `tasks.create|start(preTask)` → `loadLoopConfig` (loop/config.ts, ENV читается один раз на задачу) → `buildLoopContext` (context.ts:48: retrieval ‖ recall ‖ каталог навыков с таймаутами 350/700/2500 мс → `buildPrompt` → `makeToolSetBuilder` → `buildConvo` → `makeToolCtx` → замыкания lease/notes/tiers) → `armAckTimer` (4 с «Занимаюсь», только без sink) → `runAdmission` (admission.ts:217: очередь GUI-задач за арендой ввода → `fastReplay` слепого макроса) → цикл `runStep` до `HARD_STEP_CAP` (50; 12 на разговорном).

`runStep` (step.ts:12): cancel-флаг → `applyIterationGuards` (guards.ts:261: queueTimedOut, потолок времени, 70%-нудж+страховочный чекпойнт, контекст-окно soft/hard+mask-observations, early-wrap, live-refresh снимка ПК, refresh выделения, `waitPauseAndSteer`, `spend.check`) → `adjustTierBeforeCall` → `prepareCall` (cache-breakpoint + per-round thinking) → `callModel` (stream только шаг 0 / разговорный финал; иначе `llm.complete`) → `accountRound` (usage/деньги/метрики/cache-thrash WARN) → `noteStub` → ветка **текст** (`handleTextTurn`: докрутка max_tokens → анти-капитуляция → verify-нудж → goal-check → пустой финал) либо **инструменты** (`runToolRound`: notifyToolRound → pushAssistantTurn → параллельный prefetch read-only → на каждый вызов: cancel, canonicalUse, skipAfterStop, аренда ввода+гард протухшего клика, `dispatchTool`, noteToolCall/applySuccessEffects/applyRoundFlags/countFamilyCall/noteRoundStop, closeRound с парными tool_result → `finishRound`: ladderHint, commitRound (журнал, prune скринов), tradingEscalation, ожидание канала, escalateOnFailedRound §7, anti-runaway identical/family, round++).

Конец: `finally` (ack-таймер, слот разговорного хода, аренда ввода, `checkpoints.clearIf`, `llm.release(taskId)`) → `computeOutcome` → `finalizeTask` (self-learn, исход навыка, компиляция макроса, `metrics.record`) → `selectTerminal` (terminal.ts:336, таблица `TERMINALS` :322 — порядок = приоритет честности, не переставлять).

### 1.3 Состояния, таймеры, пороги
| Что | Значение | Где |
|---|---|---|
| потолок задачи | 240 с (`JARVIS_TASK_MAX_MS`, [30 с;30 мин]); ×2 если основной канал `off` (подписка) | config.ts:17, tiering.ts:29 |
| 70% потолка → нудж «сворачивайся» + чекпойнт hardKill | один раз | guards.ts:15 |
| early-wrap: остаток < 0,9·средний раунд | | guards.ts:125 |
| контекст soft/hard | 150K / 185K токенов; hard сперва маскирует старые наблюдения | config.ts:28-35, guards.ts:52 |
| очередь GUI-задач / аренда ввода | 90 с / 60 с; протухший клик > 10 с | config.ts:9,36 |
| промоушен sync-first | пол 1,5 с от первого tool_use, кап 6 с; tier0: 1,5 с | index.ts:500-504 |
| ack-таймер фона | 4 с | ack-timer.ts:9 |
| эхо-гейт после терминала | 90 с, только при ЕДИНСТВЕННОМ свежем `done` | turn-intercepts.ts:53 |
| чекпойнт TTL / окно предложения «продолжи» | 30 мин / 3 мин | checkpoint-store.ts:26, checkpoint.ts:634 |
| подтверждение «да» после вопроса Джарвиса | 5 мин (хардкод) | index.ts:214 |
| ожидание канала ПК | 30 с (на импорте модуля!) | util.ts:351 |
| пауза | опрос 150 мс, потолок 5 мин | util.ts:345 |
| реестр задач: sweep 5 мин, retention 6 ч; диск-персист debounce 300 мс, TTL 24 ч | | gateway/server.ts:354, task-store.ts:25 |
| дубль-гейт e5: только ≤3 токенов, порог 0,86, бюджет 400 мс | | turn-intercepts.ts:44,75 |
| эскалация §7: 2 провальных раунда подряд; family-cap 6 → boost на 2 раунда; verify-нуджи ≤2; retry-нуджи ≤2; докрутки ≤6 | | config.ts:41-89 |

### 1.4 Инварианты (нарушение = дефект)
1. Честность исхода: три исхода отправки (`confirmedSends/declinedCalls/uncertainCalls`), `taskOk` — единственный список неуспехов (outcome.ts:80); терминал провала НЕ переиспользует текст модели (terminal.ts:224).
2. `convo` всегда кончается user-сообщением (convo.ts:19); на КАЖДЫЙ `tool_use` парный `tool_result` (tool-round.ts:132); thinking-блоки первыми в assistant-ходе; ровно один cache-breakpoint (util.ts:417).
3. `llm.release(taskId)` и снятие аренды ввода — в `finally` на любом выходе (index.ts:551-569); чекпойнт гасят ТОЛЬКО терминалы (успех/отмена), не петля.
4. Dev-сессия изолирована: своя память, задачи `dev`, без самообучения/рефлексов, **без чекпойнтов** (router-ws.ts:436).
5. Реплика без «Джарвис» (`viaWake=false`) не меняет долговременное: профиль, факты, навыки, слепой реплей (unaddressed.ts).
6. Машинный реэнтри (`origin:"watch-action"`) обходит steer/дубль/clarify и не пишет чекпойнт.
7. Голое «продолжи» крадём у плеера только внутри окна предложения (turn-intercepts.ts:397-412).

## 2. Возможности
Полный перечень с `entry/needs/testedBy` — в `agent-loop-router.json` (capabilities[]). Сводка по группам (id → смысл):

| Группа | Возможности |
|---|---|
| Перехваты хода | `icpt.name` «зови меня X»; `icpt.not-for-me`; `icpt.presence` (слышишь/тут/приём/время без модели, presence.ts:68); `icpt.mode`; `icpt.emotion`; `icpt.dup-gate` (лекс+e5+полярность); `icpt.steer` (правка на ходу/статус-запрос); `icpt.reflex-fact`; `icpt.reflex-commit`; `icpt.clarify-answer`; `icpt.echo-gate`; `icpt.resume` |
| Роутер | `router.tier0-launch/focus/open/media/volume/selection`; `router.concierge`; `router.garbled`; `router.trading`; `router.smalltalk`; `router.question`; `router.reaction`; `router.confirm-affirm`; `router.action` |
| Исполнение хода | `run.tier0`, `run.tier0-promote`, `run.cache`, `run.sync-first`, `run.bg-task`, `run.ack-timer`, `run.queued-pretask` |
| Контекст/промпт | `ctx.retrieval`, `ctx.skill-hint-gate`, `ctx.prompt`, `ctx.tool-set-lazy`, `ctx.convo`, `ctx.thinking-round`, `ctx.stream-final` |
| Admission/реплей | `adm.gui-queue`, `adm.fast-replay` (+гейт §P0, префилл, nav-refusal) |
| Раунд | `round.prefetch-parallel`, `round.input-lease`, `round.stale-click`, `round.stop-after-fail`, `round.uncertain-debt`, `round.family-count`, `round.ladder-hint`, `round.prune-images`, `round.channel-wait`, `round.cancel` |
| Тиры | `tier.escalate-failed`, `tier.quality`, `tier.executor-down`, `tier.family-boost`, `tier.trading-lock`, `tier.cap-by-channel` |
| Гарды | `guard.time-cap`, `guard.budget-nudge`, `guard.context`, `guard.early-wrap`, `guard.live-refresh`, `guard.selection-refresh`, `guard.pause-steer`, `guard.spend`, `guard.runaway-identical`, `guard.runaway-family` |
| Нуджи | `nudge.max-tokens`, `nudge.anti-capitulation`, `nudge.verify`, `nudge.goal-check`, `nudge.empty-final` |
| Исход | `out.compute`, `term.*` (12 терминалов), `fin.self-learn`, `fin.skill-outcome`, `fin.macro-attach`, `fin.metrics` |
| Задачи | `task.lifecycle`, `task.cancel-user`, `task.persist`, `task.sweep`, `task.control-classify`, `task.scope`, `task.narrate`, `task.misfire` |
| Чекпойнты | `cp.save`, `cp.digest`, `cp.store`, `cp.resume-gating` |
| Персона | `persona.build`, `persona.lean`, `persona.modes`, `persona.emotion` |

## 3. Швы (seams) — как подменять
| Шов | Где | Как в лаборатории |
|---|---|---|
| LLM | `ILlmProvider` (integrations/llm.ts:120) | `MockLlmProvider(script: MockTurn[])` (llm.ts:204; пишет `requests[]`, `usage`/`stopReason` переопределяются); `ScriptedLlm` (gateway/bench/scripted-llm.ts — отличает вызов петли по `sessionKey`, побочные вызовы получают стаб, конец скрипта → `stub`+`exhausted`); подписка: `scriptedSdk(steps)` (integrations/test-support/scripted-sdk.ts) под `SubscriptionLlmProvider` |
| Сессия/клиент ПК | `Session` (`sendAction/send/requestConfirm/channelUp`) | `fakeSession()` (agent/index.test.ts:27); bench-сокет (gateway/bench/bench-socket.ts: §14 по политике, ActionCommand → честный отказ) |
| Часы/таймеры | `Date.now`, `setTimeout` прямо в index/guards/turn-intercepts | `vi.useFakeTimers`; `TaskManager(now)`, `CheckpointStore(dir, now)`, `waitWhilePaused/waitForChannel(…, nowFn, sleepFn)`; `presenceVoice(kind, now)` есть, но `interceptPresence` `now` не передаёт (presence.ts:74) |
| Память/БД | `EpisodicMemory`, `WorkingMemory`, `SkillProvider`, `ResponseCache`, `IEmbeddingProvider` | `InMemoryEpisodicMemory`+`HashEmbeddingProvider`, `new WorkingMemory()`, `fakeSkills()`; БД — PGlite (`DATABASE_URL=pglite://`), бенч так и делает |
| Веб | `IWebProvider` | `MockWebProvider` |
| Файлы данных | профиль, `tasks.json`, `checkpoints.json` | `JARVIS_DATA_DIR` на temp (vitest.setup.ts делает сам); `lazyDataPath` кэшируется — сбрасывать |
| Расширение/Chrome | `deps.ext`, `deps.openOrFocus` | объект-заглушка `{connected,openOrFocus,tab*}` (index.test.ts:706); реальный — стенд infra/bench |
| Каналы модели | `llm.channelStatus()` | влияет на потолок ×2; в моке не задан → базовый |
| Настоящий мозг | `SubscriptionLlmProvider` | нужен `CLAUDE_CODE_OAUTH_TOKEN` или `~/.claude/.credentials.json` владельца (`_jarvis_subscription_check.mjs`); гонять через `_jarvis_cmd.mjs`/`/dev/say` |
| Границы процесса | `persona.md` кэш на процесс; `CHANNEL_WAIT_MS` на импорте | перезапуск процесса / `vi.resetModules` |

Три уровня драйва: (1) in-process vitest (`handleUserText` + Mock/fake — основной); (2) реальный сервер `POST /dev/bench/say` (сессия `clientVersion:"bench"`, `JARVIS_DEV_HTTP=1`+токен, сценарный мозг; `llm.loopCalls==0` значит закрыл tier0/кэш); (3) `_jarvis_cmd.mjs` `dev.text` с настоящим мозгом (актуаторы ПК отвечают честным `ok:false`) / `/dev/say` в живой Electron.

## 4. Как проверять без человека
Почти всё — `fake-llm`+`fake-desktop`(fakeSession)+`fake-clock`: аудио, Chrome и железо не нужны. `real-brain` нужен лишь для проверки, что нуджи/персона реально меняют поведение живой модели, и для канала подписки. `liveOnly` в этой области — только то, что зависит от реального звука/окна: ничего (ни одна возможность не помечена).

Покрыто (пути от `agent/`): `index.test.ts` (106 кейсов: tier0, консьерж, дубль/steer, эхо-гейт, нуджи, §7, sync-first, кэп раундов, гарды контекста, реплей-гейты, отмена, очередь), `wave-c-continuity.test.ts` (33: чекпойнт, свёртка, early-wrap, hardKill), `selection-loop.test.ts` (72), `checkpoint.test.ts` (50), `sync-promote-loop`, `unaddressed-loop`, `presence.test.ts`, `tier0-fallback-loop`, `input-denied-loop`, `round-stop-loop`, `stream-final-loop`, `dev-isolation-loop`, `tasks/*.test.ts`, `router/*.test.ts`, `persona/*.test.ts`.

**НЕ покрыто** (grep по тестам, 0 совпадений): executor-даунгрейд `tier.executor-down` (tiering.ts:78); откат `familyBoost` (только косвенно в selection-loop); `terminalChannelLost` (есть только unit `waitForChannel`); `JARVIS_TASK_SCOPE=0`; `JARVIS_LEAN_SMALLTALK` на уровне петли; 70%-нудж `budgetNudge` петлёй (упомянут только в checkpoint.test.ts); `admitGuiTask` таймаут очереди (лишь косвенно в input-denied); `interceptPresence` при активной задаче/`pendingClarify` в петле; `confirmationAware` целиком (только reaction.test + sync-promote); `terminalLlmStubbed` при уже озвученном стабе; путь `JARVIS_SYNC_FIRST=0` для tier0; resume-путь из dev-сессии невозможен (нет `checkpoints`).

Реверт-проверка — правило проекта: тест ценен, если падает на сломанной реализации (`scripts/mutate-loop.cjs`).

## 5. Дефекты и долг
| Серьёзность | Где | Что |
|---|---|---|
| med | `agent/index.ts:571-576` | `computeOutcome/finalizeTask/selectTerminal` вызваны ПОСЛЕ try/catch: исключение (например в `metrics.record`, `compileReplayLines`) уйдёт наверх, задача останется `running` (не `finish/fail`), чип не закроется; дубль-гейт/steer потом будут «править» мёртвую задачу («Принял, поправляю»). Не воспроизводил живьём |
| med | `gateway/router-ws.ts:436` | у dev-сессии `checkpoints=undefined` → весь поток «прервалось → доделай» (`interceptResume`, `saveCheckpoint`, терминалы с предложением) НЕЛЬЗЯ прогнать текст-драйвером и стендом; в лаборатории нужен режим «dev + изолированный стор чекпойнтов» |
| med | `turn-intercepts.ts:328,423,426` | `interceptClarify` и `interceptResume` не передают `meta.turnSeq` (`answerOf`) в `runTier0`/`runActionSyncFirst` (типы `TurnRunners` :123-125 его не знают) → атрибуция `first_answer` (W3 V-1) на этих путях теряется |
| med | ~40 `JARVIS_*` в этой области (grep) | закон «один флаг — одно решение» (цель <100 на весь проект); часть без тестов: `TASK_SCOPE`, `LEAN_SMALLTALK`, `EXECUTOR_TIER`; `SYNC_FIRST=0` — 7 упоминаний, аварийный откат, который ветвит два пути (index.ts:176,268,425) |
| low | `agent/index.ts:317` | откат `JARVIS_SYNC_FIRST=0` для tier0: `startBackgroundTask(runLocalIntent)` не обрабатывает `fallbackToLlm` — «не нашёл приложение» озвучивается как терминал, модели ход не отдаётся (в основном пути отдаётся) |
| low | `turn-intercepts.ts:429` | resume-фон `startBackgroundTask(…, {bounded:true})` без `preTask`: задача ждёт слот семафора невидимой для «отмени всё»/дубль-гейта (нарушает W0-инвариант index.ts:339) |
| low | `agent/index.ts:142` | ветка `"haiku"` для `tier0` недостижима (tier0+local обработан выше, tier0 без local роутер не выдаёт) — мёртвый код |
| low | `agent/index.ts:12-14` | шапка устарела: «Haiku-классификатор», «TODO динамическая эскалация» — эскалация давно в `loop/tiering.ts` |
| low | `turn-intercepts.ts:226` | комментарий «деф 0.9», код `dupSemanticMin()` = 0.86 (:44) |
| low | `index.ts:214` vs `util.ts:34` | два разных «окна подтверждения»: хардкод 5 мин (`CONFIRM_REPLY_WINDOW_MS`) и `confirmWindowMs()`/`JARVIS_CONFIRM_WINDOW_MS` |
| low | `loop/util.ts:351` | `CHANNEL_WAIT_MS` читает env на импорте — противоречит граблям «.env грузится после ESM-хойстинга, читать в момент вызова»; в тестах не переопределяется |
| low | `presence.ts:74` | `presenceVoice(kind)` без `now`: время «сейчас» — часы сервера, без часового пояса владельца (`userContext.timezone`); в лаборатории только через fake-timers |
| low | размер файлов (закон №3, <150 строк) | `router/index.ts` 917, `checkpoint.ts` 710, `agent/index.ts` 665, `loop/state.ts` 573, `loop/util.ts` 467, `tasks/task.ts` 453, `turn-intercepts.ts` 452, `tasks/manager.ts` 426, `loop/terminal.ts` 347 (`terminalSuccess` ~75 строк) — рефакторить без запроса не велено |
| low | `tasks/manager.ts:172-177` | JSDoc метода `cancel` стоит над `noteIrreversible` (перепутан порядок) |
| low | `jarvis/CLAUDE.md` (раздел сервера) | «persona.md (v91)»; в файле `version: 93` |
| med (для лаборатории) | `docs/HOW_IT_WORKS.md` §2a | пишет, что драйвер отвечает `action.result{ok:true}`; `_jarvis_cmd.mjs` с 2026-09-01 отвечает честным `ok:false` — введёт в заблуждение при проектировании стенда |
| low | `gateway/dev-session.ts:21` (смежное) | `isDevSession` = regexp `/cmd|test|driver|qa|smoke|probe|bench|script/i` по подстроке `clientVersion`: строка версии настоящего клиента, содержащая, например, «qa»/«test», станет dev-сессией (память и чекпойнты владельца отключатся) |

Не нашёл: гонок в `promoteRace` (таймеры чистятся в `finally`, `detached` ставится синхронно), утечек аренды ввода (снимается в `finally`).

## 6. Что лаборатория обязана уметь
1. Гонять `handleUserText` с управляемым мозгом (Mock/Scripted, включая `usage` для гардов контекста и `stopReason`) и **fake-clock** для промоушена, ack, эхо-гейта, TTL чекпойнта, очереди, паузы.
2. Режим «dev-сессия + изолированные `CheckpointStore` и `TaskManager`(now)» — иначе не проверить resume/чекпойнты/персист задач.
3. Фейковый ПК-клиент, отвечающий на `action.command` по сценарию (ok/fail/uncertain/overlay_drawing/канал упал), плюс скриптуемые §14-вопросы.
4. Реальный мозг по подписке как отдельный прогон (`real-brain`+`owner` для токена) на наборе «нудж-сценариев»: проверять, что нуджи меняют поведение модели, а не только что они впрыскиваются.
5. Снимок «журнала хода»: раунды модели (что показала петля), состояние `LoopState`, терминал, `metrics.record`, задача в реестре — для ассертов вместо разбора логов; и мутационная реверт-проверка каждого нового теста.
