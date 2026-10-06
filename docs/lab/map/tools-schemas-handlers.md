# Карта: схемы инструментов и хендлеры (tools-schemas-handlers)

Область: `packages/tools/src/index.ts` (+`gui-schemas.ts`, `facades.ts`, `catalog.ts`) и `apps/server/src/brain/tools/{dispatch.ts,handlers/*}`.
Сокращения: **S** = `apps/server/src/brain/tools/`, **C** = `apps/client/main/actuators/index.ts`, **H/C** = hot/cold.
Только чтение; сервер/клиент не запускались. Тесты — по grep имён, «нет» = хендлер-теста не нашёл.

## 1. Как работает

**Схемы.** `TOOL_SCHEMAS` (index.ts:2012) = 113 схем: 112 в index.ts + `act` (gui-schemas.ts:89). 60 горячих (`HOT_TOOL_CEILING=60`, index.ts:2163; вес
Σ JSON ≤ 65 000, `HOT_CHARS_CEILING`, тест w3-arsenal.test.ts:80) и 53 холодных (`COLD_TOOL_NAMES`, index.ts:2044: строка каталога + `tool_load`).
`EXCLUDED_TOOLS` (agent/loop/util.ts:155: demo_record, message_send, order_place) модели не предлагаются вовсе → фактически видно 110.
`ACTUATOR_TOOL_BY_KIND` (index.ts:71) — `Record<ActionKind,string>` на 59 kind (compile-time покрытие протокола). Поля команды берутся ТОЛЬКО по
схеме (`pickBySchema`, S/command-fields.ts:24), служебные `origin`/`approval` ставит сервер.

**Фасады** (`facades.ts:38 canonicalToolCall`, вызывается в начале dispatchTool и в петле): `look{what}`→ui_snapshot|screen_read_text|window_list|context_read;
`window{op}`→window_focus|window_list|window_arrange; `audio{op}`→audio_sessions|audio_set; `browser_tabs{op:close}`→browser_close; `web_read{view:elements}`→web_inspect.
Неизвестный what/op → имя фасада как есть → «Неизвестный инструмент». Вход НЕ мутируется (иначе подвиснет SDK-хендлер подписки).

**Поток `dispatchTool` (S/dispatch.ts:403)**
1. фасад → канон (:410); `act{steps}` → `actSteps` (handlers/act-steps.ts:87) ДО гейтов (каждый шаг сам идёт через dispatchTool, :412);
2. `withTaskFrame` (frame-memory.ts): x/y без кадра задачи → отказ (:414);
3. §0 `credentialGate` (credential-gate.ts:24, :416) — отказ ошибкой; примечание к успеху в эпилоге (`credentialGateNotes`, :419);
4. `dispatchToolCore` (:424): `productMode`+self_* → отказ (:432) → **switch серверных** (:437–593) → MCP (:599: SSRF аргументов, `requiresConfirm`→§14, untrusted-обёртка)
   → самописные (:645 `runDynamicTool`→`executeGuardedCode`) → блок мыши в браузерной задаче (:663) → `code_run`/`job_status`/`order_place` (:673–676)
   → **confirm необратимого** fs_delete / system_power (кроме sleep/cancel) / app_close force (:681) → SSRF+DNS навигации web_*/app_launch{http} (:703, nav-dns.ts)
   → **§14 guiGate** (:707; ui_invoke/input_key/input_click/act/input_type) → `web_open` запоминает цель (:709) → `web_act` (:710) → `wait_for` browser (:716)
   → **общий актуаторный путь**: `KIND_BY_TOOL` (:721) → `commandFromInput` (:726) → `sendActionApproved` (:731, один вопрос+один повтор по `needsApproval`) → разбор `ActionResult`:
   `actResult` для gui.act; fused-наблюдение (`observed`); сенсоры → `untrustedCapped` + `empty`; jbrowser.* → untrusted; fs.read/search → untrusted; иначе `ok(capResultBody)`;
   ошибка: `overlayDeniedResult` / `injectedFailure` / `channel_down` (`channelDown:true`) / `visionFallbackHint`.
5. `noteFrame` (кадр screen_capture виден следующим шагам серии).

**Флаги честности `ToolResult`** (dispatch.ts:236–380): `sent` / `declined` / `uncertain` (закон 1), `observed`, `empty`, `channelDown`, `overlayDenied`+`overlayStepIndex`+`overlayActionInjected`,
`veiled`, `backgroundJob`/`jobId`/`jobLaunched`, `partialSteps`/`partialInjected`, `idleWaitMs`. Петля (agent/loop) классифицирует эффект по `error-voice.ts:147 toolEffect`
(verify/mutate/neutral; `OUTBOUND_SEND_TOOLS`:248 = telegram_send, telegram_send_voice, message_send, order_place, mail_send).

**Инварианты.** (а) всё, что читается извне — в `<untrusted_content>` (web/browser/ocr/fs/mcp/code-вывод); (б) ложный успех запрещён: отказ §14 = `declined`, обрыв = `uncertain`;
(в) SSRF/DNS-суд ДО §14 и памяти цели; (г) MCP и самописные не затеняют штатные (`!KIND_BY_TOOL[name]`); (д) `devSession` пропускает memory_write/forget, skill_save/promote, app_channel_learn/forget;
(е) `productMode` отключает self_*; (ж) `tool_load` кладёт имена в `toolActivation`, схемы попадают в набор со следующего построения (`tool-set.ts:19`), исполнение по имени работает и без схемы.

## 2. Возможности: tool → handler → action/service → гейты → как тестировать

`тест`: **U** — юнит с моком ToolContext; **F** — нужен фейковый клиент ПК (ActionKind); **X** — фейк `ctx.ext`/стенд Chromium; **D** — БД/PGlite; **T** — fake timers; **L** — liveOnly.
Handler «generic» = общий путь dispatch.ts:721–731 (без своего хендлера).

### 2.1 GUI-руки и глаза (клиентские, `ActionCommand`)
| tool | H/C | handler | kind → клиент | гейты | внешнее | тест |
|---|---|---|---|---|---|---|
| act | H | generic + `actResult` act.ts:55; серия act-steps.ts:87 | gui.act → C:396 (`act()` act.ts) | §0 (type/set), §14 guiGate :707 (Enter/«Оплатить» в мессенджере/банке/1С), клиентский рубеж инжекции `needsApproval`, frame П5 | UIA-сайдкар, OCR, SendInput | F; act.test.ts, act-steps.test.ts, gui-approval-w2.test.ts |
| look{elements} → ui_snapshot | H (фасад) / C | generic | ui.snapshot → C:411 | untrusted, `empty`≠сверка | UIA | F; sensor-empty.test.ts |
| look{text} → screen_read_text | H / C | generic | screen.ocr → C:636 | untrusted | Windows OCR | F |
| look{windows}, window{list} → window_list | H / C | generic | window.list → C:416 | untrusted | Win32 | F |
| look{context} → context_read | H / C | generic | context.read → C:659 | untrusted, empty | UIA TextPattern | F |
| window{focus} → window_focus | H / C | generic | window.focus → C:420 | untrusted | Win32 | F; **нет теста** |
| window{minimize\|maximize\|restore\|move} → window_arrange | H / C | generic | window.arrange → C:451 | — | Win32, мониторы | F; нет теста |
| audio{list} → audio_sessions / audio{set} → audio_set | H / C | generic | audio.sessions C:478 / audio.set C:483 | — | Core Audio WASAPI | **L**; нет теста |
| app_launch | H | generic | app.launch → C:296 | SSRF если http (:703) | shell | F; nav-dns-dispatch.test.ts, input-batch.test.ts |
| app_focus | C | generic | app.focus → C:300 | — | Win32 | F; input-batch.test.ts |
| app_close | H | generic | app.close → C:314 | confirm при `force` (:681) | процессы | F; нет теста |
| ui_ground | C | generic | ui.ground → C:407 | untrusted | UIA | F; gui-approval-w2.test.ts |
| ui_invoke | C | generic | ui.invoke → C:402 | §0 setValue, §14 guiGate | UIA | F; commit-gate-dispatch.test.ts |
| input_type | C | generic | input.type → C:353 | §0, §14 (Enter), veil, USER_BUSY (proactive) | SendInput | F; credential-w2.test.ts |
| input_key | H | generic | input.key → C:359 | §14 guiGate, key-combo контракт | SendInput | F; key-combo-contract.test.ts |
| input_click | C | generic | input.click → C:366 | блок мыши в веб-задаче :663, §14 | SendInput/UIA | F; commit-gate-dispatch.test.ts |
| input_mouse | C | generic | input.mouse → C:383 | блок мыши :663 | SendInput | F; input-kinds.test.ts |
| input_batch | C | skills.ts:175 → skill.execute | skill.execute → C:583 | блок мыши в веб-задаче :540, SSRF шагов, §14 batchGate (batch-commit.ts), лимит 12 | раннер навыков | F; input-batch.test.ts, batch-commit.test.ts |
| screen_capture | H | screen.ts:38 `lookAtScreen` | screen.capture → C:623 | visionCap П5, veiled | desktopCapturer | F; dispatch-vision.test.ts |
| screen_selection | H | selection.ts:72 | screen.selection → C:645 | `overlay_drawing`, machineTurn запрет | оверлей владельца | **L** (start); selection.test.ts (view/логика) |
| screen_probe | C | generic | screen.probe → C:641 | — | pHash | F; нет теста |
| wait_for | H | generic; browser-условие → dispatch.ts:910 | wait.for → C:653 (window/ui/text/sound/gsi/process/file) | untrusted, met→observed | UIA/OCR/Core Audio; browser — ext | F+T; browser-condition.test.ts |
| file_view | H | file-view.ts:42 | fs.view → C:617 | untrusted (текст на картинке) | PDF/картинки диска | F; file-view.test.ts |
| demo_record | C+EXCL | generic | demo.record → C:664 `notImplemented(M4)` | — | — | мёртв; нет теста |

### 2.2 Файлы, система, программы
| tool | H/C | handler | kind → клиент | гейты | тест |
|---|---|---|---|---|---|
| fs_read | H | generic | fs.read → C:716 | untrusted+кап 80K (:790) | F; result-cap.test.ts |
| fs_write, fs_edit | H | generic | fs.write C:718 / fs.edit C:720 | §0 (содержимое, credential-guard) | F; credential-guard.test.ts |
| fs_append | C | generic | fs.append → C:722 | — | F; нет теста |
| fs_list, fs_mkdir, fs_move | H | generic | fs.list C:724 / fs.mkdir C:731 / fs.move C:729 | — | F; нет теста |
| fs_delete | H | generic | fs.delete → C:726 | **confirm** :681 (необратимо) | F; dispatch-confirm-declined.test.ts |
| fs_search | H | generic | fs.search → C:733 | untrusted | F; result-cap.test.ts |
| system_lock | H | generic | system.lock → C:737 | — | **L**; нет теста |
| system_power | H | generic | system.power → C:738 | **confirm** кроме sleep/cancel | **L** (эффект); confirm — dispatch-confirm-declined.test.ts |
| system_media, system_volume, system_layout | H | generic | system.media/volume/layout → C:739–742 | «пауза» жать только при звуке | F; volume — input-kinds.test.ts |
| system_clipboard | H | generic | system.clipboard → C:741 | §0 запись/вставка | F; credential-guard.test.ts |
| monitor_set, monitor_list, monitor_assign | C | generic | monitor.set C:756 / .list C:760 / .assign C:763 | index вне диапазона → ошибка | F; нет теста |
| office_excel, office_word | C (промоут) | generic | office.excel C:746 / office.word C:748 | — | **L** (COM); hot-promotions.test.ts |
| obs_request | C (промоут) | generic | obs.request → C:752 | — | **L**; hot-promotions.test.ts |
| code_run | H | code.ts:26 `runCodeGuarded`→`executeGuardedCode`:57 | code.run → C:494 | lint (code-guard), confirm необратимого, SDK-фон запрещён, untrusted вывод | F; code-background.test.ts, code-untrusted.test.ts |
| job_status | H | code-job.ts:14 | job.status → C:540 | veil | F; code-background.test.ts |
| app_channels | H | app-channels.ts:149 | сервер (реестр каналов) | — | U; app-channels.test.ts |
| app_channel_learn / _forget | C | app-channels.ts:212 / :321 | сервер + проба через `code_run` | devSession-пропуск, probe-якорь, loopback | U+F; app-channels.test.ts |

### 2.3 Браузер (расширение Chrome, `ctx.ext`; ActionCommand НЕ эмитят)
| tool | H/C | handler | гейты | тест |
|---|---|---|---|---|
| browser_open | H | browser.ts:108 | SSRF `browserUrlBlocked`, veil (:119), focus существующей вкладки | X; dispatch-browser.test.ts, browser-veil.test.ts, browser-ssrf-e2e.test.ts |
| browser_act | H | browser.ts:326 | §14 web-place/`confirmWebCommit`, guard страницы на ЛЮБОМ хосте, `commit_confirm`→вопрос→один повтор, §0, secretFieldRefusal | X; dispatch-browser*.test.ts, browser-approval-e2e.test.ts, web-commit-guard.test.ts, bench bank.test.mjs |
| browser_batch | H | browser.ts:524 (+browser-batch-outcome.ts:39) | общий вопрос по рискованным шагам :557, стоп на uncertain | X; dispatch-browser-w1.test.ts, browser-ref-commit.test.ts |
| browser_read | H | browser.ts:239 (+browser-capture.ts:60 image) | untrusted, privatePlaceBlock (SSRF по месту) | X; dispatch-browser.test.ts, bench image.test.mjs |
| browser_inspect | H | browser.ts:298 | untrusted, кап 60, ref-подписи для §14 | X; dispatch-browser-w1.test.ts, web-eyes-loop.test.ts |
| browser_tabs (+op:close) | H | browser.ts:163 | untrusted заголовки | X; bench close-tab.test.mjs |
| browser_close | C | browser.ts:219 | — | X; dispatch-browser.test.ts |
| browser_sync_login | C | browser.ts:197 → jbrowser.import_cookies C:704 | — | X+F; **нет теста** |

### 2.4 Невидимый браузер Джарвиса (клиентский Chrome+CDP) и сообщения
| tool | H/C | handler | kind → клиент | гейты | тест |
|---|---|---|---|---|---|
| web_open | H | generic + rememberWebTarget :709 | jbrowser.open → C:682 | SSRF+DNS, untrusted | F+X; nav-dns-dispatch.test.ts, dispatch-jbrowser-untrusted.test.ts |
| web_read (view:elements→web_inspect) | H | generic | jbrowser.read C:686 | untrusted | F; dispatch-jbrowser-untrusted.test.ts |
| web_inspect | C | generic | jbrowser.inspect → C:690 | SSRF, untrusted | F |
| web_act | H | web-act.ts:58 | jbrowser.act → C:694 | allowlist полей, §14 хост/LMS до действия, guard страницы, один повтор | F; web-act.test.ts, moodle bench |
| web_login | C | generic | jbrowser.login → C:698 | SSRF; вход делает владелец | **L** |
| telegram_send | H | messaging.ts:67 | telegram.send → C:671 (CDP), фолбэк `ctx.telegramSend` (расширение) | §14 confirmSendOnce, cadence, resendGuard, veil, сверка доставки `telegram.read`, 3 исхода sent/declined/uncertain | F+X; messaging*.test.ts, telegram-veil.test.ts |
| telegram_read | H | generic | telegram.read → C:677 | untrusted | F; dispatch-telegram-memory.test.ts |
| telegram_send_voice | C | messaging.ts:267 | `ctx.synthVoice`+`ctx.telegramSendVoice` (расширение) | как telegram_send | **L** (микрофон-подмена) |
| message_send | C+EXCL | messaging.ts:331 | message.send → C:666 (userbot) | §14 revise-confirm, cadence, idempotency, resend | **L**; messaging.test.ts |
| order_place | C+EXCL | messaging.ts:445 | order.place → C:709 (`placeOrder` = throw «не реализован M7») | spend cap, allowlist, красная линия карты §0 | U; messaging.test.ts |
| consent_list / consent_revoke | C | messaging.ts:486 / :503 | сервер (consent.json) | — | U; **нет теста** |
| mail_send | H | mail.ts:156 | SMTP из .env + IMAP-сверка | §14 confirm-once, cadence, resend, `SmtpUncertainError`→uncertain | U с фейк-SMTP; mail.test.ts |
| mail_read | H | mail.ts:22 | `ctx.ext.mailRead` | untrusted | X; mail.test.ts |
| calendar_read | H | calendar.ts:25 | `ctx.ext.calendarRead` | untrusted | X; calendar-source.test.ts (источник) |

### 2.5 Серверные: инфо, память, время, знания, навыки, самообращение
| tool | H/C | handler | сервис | гейты | тест |
|---|---|---|---|---|---|
| web_search / web_fetch | H | info.ts:10 / :24 | `ctx.web` (Brave/DDG, SSRF-транспорт) | untrusted, ручные редиректы | U с фейк-транспортом; info.test.ts |
| knowledge_consult | C | info.ts:41 | `ctx.knowledge` | untrusted, `knowledge_miss` деградация | U; dispatch-knowledge.test.ts |
| memory_search | H | info.ts:64 | episodic (pgvector) | — | U+D; info.test.ts |
| memory_write / memory_forget | H | dispatch.ts:947 / :963 | user-memory (дедуп, профиль) | devSession и unaddressed блок | U+D; dispatch-telegram-memory.test.ts, dev-isolation-loop.test.ts |
| set_reminder | H | reminders.ts:9 | `ctx.reminders` (durable) | — | U+T; reminders.test.ts |
| cancel_reminder / list_reminders | H | reminders.ts:41 / :52 | то же | — | U+T; **нет теста** |
| watch_create | H | watch.ts:81 | `ctx.watch`; predicate window/ui/text/sound/gsi/browser | validatePredicate, SSRF/DNS url, лимиты | U+T+F; watch.test.ts |
| watch_cancel / watch_list | H | watch.ts:139 / :147 | то же | — | U+T; **нет теста** |
| obligation_add/remove/list | H | obligations.ts:14/:37/:45 | `ctx.obligations` | — | U+T; **нет теста** |
| market_quote / _candles / _analyze / _backtest / _news | C | market.ts:28/:42/:60/:85/:112 | `ctx.market` (только чтение) | — | U; dispatch-market.test.ts (news: нет) |
| tinkoff_portfolio | C | market.ts:126 | Тинькофф read-only | ключ владельца | **L**/U-мок; dispatch-market.test.ts |
| trade_predict / _winrate / _predictions | C | market.ts:149/:172/:225 | стор прогнозов | R:R ≥ 2:1, денег не двигает | U+D; dispatch-market.test.ts |
| skill_list / skill_execute | H | skills.ts:19 / :33 | `ctx.skills` → skill.execute C:583 | слоты, §0 по шагам, SSRF шагов, §14 batchGate, needsReview confirm | U+F; skill-tools.test.ts, skills-timeout.test.ts |
| skill_save / skill_promote | H / C | skills.ts:241 / :271 | `ctx.skills` | devSession-пропуск | U+D; skill-tools.test.ts |
| tool_create / tool_list / tool_remove | C | dynamic-tools.ts:12/:25/:31 | `ctx.dynamicTools` | имя/lint | U; dynamic.test.ts (хендлеры — нет) |
| tool_load | H | dynamic-tools.ts:42 | `ctx.toolActivation` | неизвестное имя → честно | U; lazy-tools.test.ts |
| self_weaknesses / self_code_search / self_code_read | C | self.ts:20/:43/:57 | телеметрия, исходники | productMode-отказ | U; weaknesses.test.ts (поиск/чтение: нет) |
| self_patch | C | self.ts:82 | ветка+verify+merge | killswitch, confirm на apply, productMode | U; self/patch.test.ts |

### 2.6 Сквозные потоки (не схемы)
`gate-pipeline` (dispatch.ts:403), `mcp-passthrough` (:599), `dynamic-tool-call` (:645), `act-steps-series` (act-steps.ts:87), `wait_for-browser` (dispatch.ts:910) — в JSON как отдельные capabilities.

## 3. Швы (seams) и как подменить
| шов | файл | подмена |
|---|---|---|
| `ctx.session` (ActuatorSink.sendAction) | dispatch.ts:98 | мок из одного метода; на стенде bench-socket.ts отказывает на любой ActionCommand → **нужен фейковый клиент ПК** |
| `ctx.confirm` | agent/loop/tool-ctx.ts:26 | bench: политика yes/no/expire/undelivered/массив (bench-socket.ts `parsePolicy`), CLI `bench.mjs tool --confirm` |
| `ctx.ext` (расширение) | dispatch.ts:222 | объект-мок (dispatch-browser.test.ts) или стенд infra/bench (Chromium+Xvfb+HTTPS-фикстуры) |
| `ctx.web`, `ctx.market`, `ctx.knowledge`, `ctx.mcp`, `ctx.skills`, `ctx.dynamicTools` | dispatch.ts:98–260 | интерфейсы, мок-объекты |
| `ctx.resolveHost` (DNS-суд) | nav-dns.ts | фейк-резолвер, rebinding-тесты |
| SMTP/IMAP | mail.ts:136 | `MAIL_*` env → локальные фейк-серверы |
| Часы | reminders.ts:15,34,56 | `Date.now()` напрямую; только `vi.setSystemTime`; DI-часов нет |
| БД/память | tool-ctx.ts:24 | in-memory или PGlite (`DATABASE_URL=pglite://`); consent/cadence/resendGuard — синглтоны (`_resetResendGuardForTest`) |
| `systemContext`, `veilDrawing`, `visionCap` | tool-ctx.ts:60 | функции в ToolContext; `client.env` на текст-драйвере не приходит |
| Набор инструментов модели | loop/tool-set.ts:19 | `toolActivation`, `appChannels` (промоут), EXCLUDED — чистая сборка |
| Bench-точка | gateway/bench/bench-tool.ts:29 | `POST /dev/bench/tool` (`JARVIS_DEV_HTTP=1`) → настоящий `dispatchTool` + `makeToolCtx` |

## 4. Проверка без человека
* **Достаточно юнита с моком ToolContext**: web_search/fetch, market_*, knowledge, memory_*, reminders/watch/obligations (+fake timers), skills, tool_*, self_*, consent_*, mail_send (фейк-SMTP), гейты §0/§14/SSRF, MCP, фасады, схемы (index/w2-schema/w3-arsenal).
* **Нужен фейковый рабочий стол (клиент ПК)**: act, look/ui_*/window/input_*/screen_*/wait_for/fs_*/system_*/monitor_*/app_*/code_run/job_status/file_view/skill_execute/input_batch/web_*/telegram_*: без него проверяется лишь серверная половина (сборка команды, гейт, разбор результата) — юниты уже делают это на моке `sendAction`.
* **Нужен Chrome+расширение**: browser_*, mail_read, calendar_read, wait_for{browser}, telegram_send (фолбэк) — стенд `infra/bench` (`node --test "infra/bench/scenarios/*.test.mjs"`: bank, close-tab, image, login, media, messenger, moodle, say, shop) или мок `ctx.ext`.
* **Настоящий мозг (LLM по подписке)**: только при проверке «модель выбирает инструмент» (сценарный мозг bench-say.ts / scripted-llm.ts подменяет; `_jarvis_cmd.mjs` текст-драйвер).
* **liveOnly (14)**: audio (facade, sessions, set), system_lock, system_power, office_excel/word, obs_request, screen_selection(start), web_login, telegram_send_voice, message_send, order_place, tinkoff_portfolio — гейты проверяются на моках, эффект — только с железом/владельцем.
* **Не покрыто тестами хендлера** (grep): app_close, window_focus, window_arrange, audio_*, fs_append/list/move/mkdir, monitor_set/assign, system_media/layout/lock, screen_probe, browser_sync_login, market_news, consent_*, cancel/list_reminders, watch_cancel/list, obligation_*, tool_create/list/remove (хендлеры), self_code_search/read, demo_record.
* Не покрыто вовсе: сквозная проводка «все 113 схем ↔ ветка dispatch»: `index.test.ts` проверяет только покрытие ActionKind, не наличие серверной ветки для серверных имён.

## 5. Дефекты и долг
| sev | где | что |
|---|---|---|
| med | dispatch.ts:663 | Блок мыши в браузерной задаче (`MOUSE_TOOLS`:394 = input_click/input_mouse) не действует на `act` (в т.ч. physical/x,y/drag/scroll): закон «мышь не двигаем в веб-задаче» и escape-hatch `canvasClickAllowed` обходятся через act |
| med | dispatch.ts:552 | Dev-сессия делит `userId` владельца (gateway/identity.ts:21,34); devSession-пропуск только у memory_write/forget, skill_save/promote, app_channel_*. set_reminder, watch_create, obligation_add/remove, consent_revoke, tool_create/remove пишут в durable-сторы владельца |
| med | index.ts:894 | demo_record: схема+ActionKind есть, модели не отдаётся (EXCLUDED), клиент `notImplemented(M4)` (C:664) — мёртвый инструмент |
| med | messaging.ts:331,445 | message_send/order_place (~200 строк гардов) недостижимы для модели (EXCLUDED, `isHot` режет и после tool_load, tool-set.ts:19); order.place на клиенте — throw «M7» (actuators/browser.ts:26) |
| low | dispatch.ts:383 | Дубль `KIND_BY_TOOL` при наличии `ACTUATOR_KIND_BY_TOOL` (index.ts:2151) — DRY |
| low | dispatch.ts:32,313 | `URL_NAV_TOOLS` посреди import-блока; осиротевший JSDoc «tool name → ActionKind» над SENSOR_KINDS |
| low | dispatch.ts:1 | Закон 3: dispatch.ts 987, index.ts 2185, browser.ts 569, messaging.ts 516 строк |
| low | catalog.ts:22 | Подсказка «app_focus = window{op:focus}» неверна: фасад → window_focus (window.focus), а app_focus → app.focus |
| low | index.ts:2044–2140 | Устаревшие цифры в комментариях (109/71/75 110 vs 113/60/65 000); тест держит только ≤65K |
| low | handlers/* | ~25 инструментов без теста хендлера (см. §4) |
| low | dispatch.ts:681 | system_power sleep, fs_write/fs_move/fs_edit без confirm — решение владельца, зафиксировано лишь комментарием |

## 6. Что должна уметь лаборатория
1. Фейковый клиент ПК на все 59 ActionKind со сценарными `ActionResult` (observation/weak, needsApproval, overlay_drawing, channel_down, stepIndex/stepActionInjected) — bench-socket.ts сейчас отказывает.
2. Политика §14-вопросов на вызов (есть в bench) + отчёт вопросов/clientActions.
3. Фейк `ctx.ext` (tabRead/Inspect/Act/Batch/Capture, calendarRead, mailRead, commit_confirm) либо стенд Chromium с HTTPS-фикстурами.
4. Управляемые часы для reminders/watch/obligations/wait_for и изолированные `userId`+data-dir на прогон.
5. Реестр покрытия: «схема ↔ ветка dispatch ↔ прогон в лаборатории» и матрица liveOnly с причинами.
