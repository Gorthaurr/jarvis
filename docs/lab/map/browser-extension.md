# Карта лаборатории: browser-extension (браузерные руки, невидимый браузер, стенд W1)

Область: `apps/extension` (Chrome MV3 «Jarvis Web Hands»), мост `apps/server/src/gateway/extension-bridge.ts` + допуск `/ext`,
handlers `brain/tools/handlers/browser*.ts` и `web-act.ts`, невидимый браузер `apps/client/main/actuators/jarvis-browser*.ts`,
облачный стенд `infra/bench` + сервер стенда `apps/server/src/gateway/bench/*`. Только чтение; проверено по коду, живьём ничего не запускалось.

## 1. Как работает

Две РАЗНЫЕ пары рук в браузере (не путать):

| | Расширение (`browser_*`) | Невидимый браузер Джарвиса (`web_*`) |
|---|---|---|
| Где | Chrome владельца, его профиль и логины | отдельный Chrome со своим профилем `%LOCALAPPDATA%\JarvisTG\tg-profile` (`jarvis-browser.ts:47`), окно за краем мониторов |
| Канал | WS `ws://127.0.0.1:8787/ext` (зашит: `background.js:28`) → `ExtensionBridge.request` | `ActionCommand` по `/ws` → клиент Electron → CDP (`jarvis-browser.ts`, `cdp-conn.ts`) |
| Инструменты | browser_open/read/inspect/act/batch/tabs/close/sync_login, telegram_send(_voice), calendar_read, mail_read | web_open/read/inspect/act/login, telegram (webK) |
| Без Electron-клиента | работает (стенд W1 его не имеет) | НЕ работает (bench: ActionCommand → честный отказ) |

### Поток `browser_*` (сквозной)
1. Модель зовёт инструмент → `dispatchTool` (`dispatch.ts:487-503`) → handler `handlers/browser.ts` (`browserOpen:108`, `browserRead:239`, `browserInspect:298`,
   `browserAct:326`, `browserBatch:524`, `browserTabs:163`, `browserCloseTab:219`, `syncLogins:197`). До моста: SSRF-гард по имени/DNS (`browser-ssrf.ts`,
   `nav-dns.ts`), §14-гейты (`commit-gate.ts`, `web-commit-guard.ts`, `browser-refs.ts`, `batch-commit.ts`), цель вкладки (`browser-target.ts`), вуаль/оверлей.
2. `ExtensionBridge` (`extension-bridge.ts:39`): `request(intent, timeoutMs)` кладёт `{id,...intent}` в WS, ждёт ответ `{id, ok, data|error, code, label}`; таймаут →
   `extNoReplyError` (исход «неизвестно», B-4, закон 1); отключение/вытеснение сокета отклоняет ВСЕ ожидающие (`rejectAllPending:72`).
   Таймауты: read/inspect 15 с, act 20 с, batch 60 с, capture 15 с, telegram 45/90 с, calendar/mail 8/40 с, cookies 20 с.
3. Service worker (`background.js`): `connect:32` → `onmessage:56` → `replyFor(msg, handle)` (`modules/reply.js`) → `handle:96` (switch по `msg.type`, 17 интентов).
   `tabAct:352` (1.5k строк god-file; ref-адресация `f<frame>e<gen>_<n>`, `parseRef` в `modules/utils.js`) выбирает page-функцию и гонит её `chrome.scripting.executeScript`
   в нужном фрейме (`page/*.js`: `ref.js` реестр ref, `robust-click.js` H19 pointer-клик + страничный гард §14, `element-act.js` set/type/select/key, `inspect.js`, `read.js`, `probe.js`).
4. Честность исхода живёт В расширении: смерть контекста при навигации → `navigated+uncertain` только для click (`navPlausible:414`), `pageLeftOutcome/slowNavOutcome`
   (`modules/page-left.js`), `ref_stale` вместо слепого хита, `tab_not_visible` у capture, self-heal `reviveTab:299` только для наблюдения (`recover`).
5. Живость: WS + `chrome.alarms` «jarvis-keepalive» 0,4 мин (`background.js:1851`) + `startKeepAlive` (15 с, на долгих операциях); реконнект 2 с (`scheduleReconnect:83`).
   Сервер: `ExtAdmission` (`ext-liveness.ts`) — новичок при живом прежнем проверяется WS-ping 1,5 с, живого не вытесняем (close 4409); Origin `chrome-extension://<pinned id>`
   обязателен (`ws-routes.ts:113-135`, `ext-id.ts`: ID из `key` манифеста `pjkeladocehklaefmnhapmmpabmaeajd`). Учёт пропажи расширения → голосовой доклад (`ext-absence*.ts`).

### Инварианты (нельзя нарушать)
- Закон 1: ответ расширения — данные с `ok/uncertain/navigated`, провал не «успех»; таймаут = «не знаю».
- Закон 5: `/ext` только с пиннингом ID, без Origin — отказ; всё со страниц — `<untrusted_content>`; `cookies.export` отдаёт куки расшифрованными (мощь — только по §14-пути `browser_sync_login`).
- Служебные поля §14 (`guard/guardApproved/approvedRef/approvedLabel`) модель не задаёт: `web-act.ts` режет allowlist'ом, browser-путь — `browser-params.ts`.
- Один активный коннект расширения на процесс сервера (нет мульти-пользователя/мульти-профиля).

### Стенд W1 (`infra/bench`, Linux-only)
`bench.mjs up` (`stack.mjs:47`): Xvfb `:99` → openbox → `prepare` (openssl-серт на SAN всех хостов `sites/hosts.json`, ffmpeg-клип, esbuild-бандл расширения в `tmp/ext`,
`server.env`, миграции PGlite) → сервер фикстур (HTTPS 443 + control 8790) → настоящий сервер Джарвиса (`tsx src/index.ts`, порт 8787, `JARVIS_DEV_HTTP=1`) → Chromium
(`chrome.mjs:8`: `--load-extension`, `--host-resolver-rules` MAP хостов фикстур → 127.0.0.1, всё прочее NOTFOUND, `--ignore-certificate-errors`, CDP 9223 только HTTP `/json/*`)
→ ждёт коннекта расширения. Управление: `POST /dev/bench/{tool,say,state,reset}` (`gateway/bench/bench-routes.ts`) → одна долгоживущая bench-сессия (`bench-hub.ts`,
`clientVersion:"bench"` = dev-изоляция), §14-ответы по политике вызова (`bench-socket.ts`, AsyncLocalStorage), мозг — сценарный `ScriptedLlm` (`scripted-llm.ts`), плейсхолдеры
`$ref:`/`$match:` (`script-refs.ts`). Проверка по ФАКТАМ фикстур (`sites-journal.mjs`, `GET :8790/events`), не по словам модели. Сценарии: `infra/bench/scenarios/*.test.mjs` (9 файлов).

### Юнит-стенды расширения (уже Windows-совместимы)
- `test/cdp-harness.mjs`: НАСТОЯЩИЙ headless Chromium с временным профилем (`findChrome:16` знает `C:/Program Files/Google/Chrome`, `CHROME_PATH`), page-функции берутся из исходников
  (`pageFunctionSources`) и гоняются через `Runtime.evaluate`; `loadServiceWorker(overrides)` — SW в `vm` с подменой `chrome.*` (быстрые юниты `tabAct`).
- `test/ext-harness.mjs`: настоящий SW в настоящем Chrome через `--remote-debugging-pipe` + `Extensions.loadUnpacked` (фирменный Chrome ≥137 игнорирует `--load-extension`);
  копия расширения с `WS_URL` → мёртвый порт 9 (`:27`) и `globalThis.__jarvisReply` — ответ SW серверу без сети; `taskkill` на win32 уже есть (`:45`).

## 2. Возможности
Полный список с точками входа — в JSON (`docs/lab/map/browser-extension.json`, поле `capabilities`). Группы:
- Вкладки: openOrFocus, list, close, read (allFrames, query-фильтр), inspect (ref-снимок / find), capture (снимок/зум, квота).
- Действия: click (pointer, H19), type/set/select/key/enter/submit/scroll_to/hover, scroll/seek/play/pause/next/prev (медиа), feed_auto (авто-подгрузка ленты), shake (встряхнуть),
  back/forward (история), batch (≤12 шагов со стопом), recover (self-heal наблюдения).
- Гарды: страничный commit-гард §14 на ЛЮБОМ сайте, LMS-путь, credential-гард (`credential-gate.ts`), SSRF/DNS, cross-frame ref.
- Сервисные (жёстко завязаны на живые сайты — liveOnly): telegram.send/send_voice/unread/diag (webK), calendar.read, mail.read, cookies.export (`browser_sync_login`), reload.
- Невидимый браузер: web_open/read/inspect/act(click,type,key,scroll,upload)/login, importCookies, telegramSend/Read; B-14 пиннинг-прокси (`jarvis-browser-proxy.ts`, SOCKS5, DNS-суд при подключении), NavGuard (`-nav-guard.ts`).
- Инфраструктура: keepalive, реконнект, ExtAdmission, ext-absence доклад, bench-сессия.

## 3. Швы (как подменять)
| Шов | Файл | Как подменить |
|---|---|---|
| Порт сервера в расширении | `background.js:28` | НЕ настраивается. Копия с подстановкой строки (как `ext-harness.mjs:27`/`bench prepare.mjs buildExtension`) → любой порт |
| Сервер ↔ расширение | `ExtSocket` (`extension-bridge.ts:32`) | мок-сокет в `extension-bridge.test.ts`; в `ToolContext.ext` (`dispatch.ts:225`) можно подать фейковый bridge |
| Расширение в браузере | `chrome.*` | `loadServiceWorker(overrides)` (vm) или `launchExtension()` (настоящий Chrome) |
| Chrome/Chromium | `cdp-harness.findChrome`, `bench/config.findChrome` | `CHROME_PATH`; bench ищет только Linux-пути (см. долг) |
| DNS/HTTPS сайтов | `chrome.mjs` `--host-resolver-rules` + серт | фикстуры на реальных именах хостов (§14 судит по хосту) — единственный правильный подход |
| Мозг | `ScriptedLlm` (`bench/scripted-llm.ts`) | сценарий ходов; для «настоящего мозга» — `deps.llm` реальный (подписка) вместо стаба (сейчас недостижимо из bench-сессии) |
| §14-вопросы | `BenchSocket` | политика `confirm: yes|no|expire|undelivered|[...]` |
| Клиент ПК (актуаторы) | `ActionCommand` | bench-сессия отказывает; для `web_*` нужен фейковый клиент/`JarvisBrowser` из `client/main/test-support/jb-fixtures.ts` (vitest + мок electron) |
| Невидимый браузер | `JarvisBrowserOpts` (`jarvis-browser.ts:131`) | `chromePath, profileDir, startUrl, resolveHost, mapAddress` — уже тестопригодны |
| Часы | `Date.now`/`setTimeout` внутри SW и хендлеров | фейковых часов нет; таймеры расширения — реальные (кроме `loadServiceWorker`: заглушки) |
| Профиль/данные сервера | `JARVIS_DATA_DIR`, `DATABASE_URL=pglite://` | отдельный каталог на прогон (bench так и делает) |

## 4. Как проверять без человека
Уровни: U — юнит/vm; C — настоящий Chromium (page-функции); E — настоящий Chrome + SW; B — bench (сервер+расширение+фикстуры, сценарный мозг); R — настоящий мозг; L — liveOnly.

| Возможность | Уровень | Покрытие есть | НЕ покрыто |
|---|---|---|---|
| click/H19, robust-click | C | `page-click`, `page-react`, `page-keys` | canvas/shadow-DOM редкие случаи |
| guard §14 на странице | C+B | `page-guard*`, `page-approve`, `bench/bank,messenger,shop` | новые виды подписей (только через стенд) |
| inspect/read/ref | C | `page-inspect`, `page-read`, `page-snapshot` | огромные SPA, iframe кросс-origin в живых сайтах |
| batch | C+B | `page-batch`, `bench/shop` | |
| capture | C+E | `page-capture`, `sw-capture-quota`, `bench/image` | HiDPI/смена масштаба на Windows |
| nav/bfcache/уход страницы | E | `sw-nav-bfcache`, `sw-page-left`, `sw-honesty` | реальный Moodle |
| вкладки (find/list/close) | U+E | `sw-tabs`, `tab-act`, `bench/close-tab` | много окон/профилей |
| media play/pause/seek | C+B | `page-media`, `bench/media` | DRM/YouTube-плеер |
| feed_auto | C | `page-read` (feed.html), сервер `browser-feed-auto.test.ts` | реальные бесконечные ленты |
| Мост/допуск/ping | U | `extension-bridge.test`, `ext-channel.test`, `ext-absence*.test` | реконнект настоящего MV3 SW после сна (вживую) |
| Login-стена/пароли (§0) | B | `bench/login` | реальные логины Chrome (пароль подставляет Chrome) |
| Moodle/тесты LMS | B | `bench/moodle` (фикстура, не настоящий Moodle) | настоящий ЭИОС |
| web_* невидимый браузер | C(vitest) | `jarvis-browser-{dns,pin,ssrf}.chromium.test`, `-proxy*.test`, `-nav-guard.test` | web_login (видимое окно), telegramSend/Read, upload |
| telegram/mail/calendar через вкладку | L | ничего автоматического | нужны залогиненные вкладки владельца |
| cookies.export | U (мост) / L (Chrome) | `dispatch-*` тесты с моком | реальный `chrome.cookies` расшифровка |
| Перезагрузка расширения/установка | L | — | «Chrome помнит путь» (24.09) — проверяется только на профиле владельца |

## 5. Дефекты и долг
| Серьёзность | Где | Что |
|---|---|---|
| high (для лаборатории) | `infra/bench/config.mjs:12`, `stack.mjs:19` | `PORTS.server=8787` и preflight «порт занят → отказ»: на ПК владельца при живом супервизоре стенд не поднимется, а форс-подъём конфликтует с боевым сервером. Нужен параметр порта + сборка расширения с подменой `WS_URL` |
| high (для лаборатории) | `infra/bench/{stack,proc,chrome,view}.mjs` | Linux-only: Xvfb, openbox, `/tmp/.X11-unix`, `process.kill(-pid)`, `import -window root`, `/opt/pw-browsers`, `xdotool/wmctrl`, `chmod 0o600`. На Windows не работает вообще |
| med | `chrome.mjs:12` | `--load-extension` не работает в фирменном Chrome ≥137 (уже отражено в `ext-harness.mjs:4`); стенд рассчитан на Chromium Playwright. На Windows нужен Chromium или CDP `Extensions.loadUnpacked` через pipe |
| med | `apps/extension/background.js` (1859 строк) | god-file, нарушает закон 3 (старый файл, без запроса не трогать); page-функции уже вынесены в `page/`, telegram/calendar/mail-инжекторы (`:1218-1859`) остались |
| med | `apps/extension/dist/` | `dist/` в `.gitignore` (правило `dist/`), а `manifest.json` указывает на `dist/background.js` → свежий клон без `node scripts/build.mjs` даёт нерабочее расширение; тихо устаревший dist = «руки старой версии». Стенд от этого защищён (собирает свой бандл) |
| low | `background.js:60` | `hello` шлёт `version:"0.1.0"`, а манифест — `version_name 0.2.0`: сервер (`extension-bridge.ts:92`) hello игнорирует, версию не сверяет → устаревшее расширение не детектируется (комментарий про «Обновить в chrome://extensions» держится на `refMode:true` костыле) |
| low | `extension-bridge.ts:154+` | `telegramDiag` отсутствует в мосте, `telegram.diag` зовётся только dev-роутом `server.ts:443` через `request` напрямую — недокументированный интент |
| low | `infra/bench/prepare.mjs:19` | серт `-days 30` переиспользуется по SAN-штампу без проверки срока; на живучесть не влияет (`--ignore-certificate-errors`), но при строгом режиме сломается через месяц |
| low | README bench | «Один стенд на контейнер»: `PORTS.sites=443` — на Windows может быть занят IIS/Skype/VPN-клиентом |
| info | `infra/bench/scenarios/defects.mjs` | `DEFECTS = {}` — открытых дефектов от стенда нет |
| info | мозг стенда | сценарный: качество решений модели стенд не проверяет (только проводку/гейты/честность); «настоящий мозг» из bench-сессии недостижим (`bench-hub.ts:56` подставляет `ScriptedLlm`) |

## 6. Расширение до ЛОКАЛЬНОЙ лаборатории на Windows (без вмешательства в Chrome владельца)
1. Изоляция: свой `--user-data-dir` во временном каталоге (никогда не профиль владельца и не `JarvisTG\tg-profile`), свой `JARVIS_DATA_DIR`, PGlite; Chrome владельца не трогать и не убивать (kill только по своим pid / `taskkill /PID … /T`).
2. Порт: сервер лаборатории на свободном порту (напр. 18787, `PORT` в env); расширение — КОПИЯ с подстановкой `WS_URL` (шаблон — `ext-harness.buildCopy`, с проверкой, что строка найдена) или проще — второй шов: `WS_URL` из `chrome.storage`/query недоступен сейчас, поэтому подмена строкой при сборке. ID расширения тот же (`key`), пиннинг `JARVIS_EXT_ID` не менять.
3. Браузер: Chromium Playwright (`%LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win\chrome.exe`) или Chrome + `--remote-debugging-pipe --enable-unsafe-extension-debugging` + `Extensions.loadUnpacked`. Окно: `--headless=new` (вместо Xvfb+openbox) — расширения в new-headless работают (уже используется `ext-harness`).
4. Хосты: `--host-resolver-rules` тот же, HTTPS-фикстуры на 443 (проверить свободу порта) или любой порт + `MAP host 127.0.0.1:PORT` (правило поддерживает порт; серт на SAN, `openssl` есть в Git for Windows; ffmpeg может отсутствовать — фикстура видео честно деградирует).
5. Процессы: заменить `spawnDetached`+`kill(-pid)` на `child_process` + `taskkill /T /F`; блокировки (`lockDir`) работают (mkdir); `displayLock`/Xvfb — выкинуть; `shot` — CDP `Page.captureScreenshot` вместо `import -window root`; OCR — по надобности `tesseract` Windows или пропустить.
6. Сервер: Node ≥20 на Windows запускает `node --import tsx src/index.ts` как есть; env — только чистый (без ключей владельца), `JARVIS_DEV_HTTP=1` + токен.
7. Мозг: три режима — сценарный (детерминизм, CI), настоящий по подписке (Agent SDK; сессия SDK на задачу — расходует лимит владельца, включать только по команде), запись/повтор.
8. Для `web_*`: либо фейковый `/ws`-клиент, поднимающий `JarvisBrowser` (`jb-fixtures.ts` + мок electron), либо vitest-`*.chromium.test.ts`; отдельный Electron в лаборатории не нужен.
9. liveOnly остаётся: telegram/calendar/mail на реальных вкладках, cookies-расшифровка, установка/перезагрузка расширения в профиле владельца.
