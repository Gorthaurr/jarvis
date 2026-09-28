# Карта: существующая тестовая инфраструктура (test-infra-existing)

Прочитано без запуска (тесты/сервер не гонялись): времена прогона ниже — ОЦЕНКИ, замеров в репозитории нет.

## 1. КАК РАБОТАЕТ

### 1.1 Слои проверки (снизу вверх)

| Слой | Инструмент | Объём | Мозг | Внешний мир |
|---|---|---|---|---|
| Типы | `pnpm -r typecheck` (tsc --noEmit, `tsconfig.base.json`: strict, noUncheckedIndexedAccess) | server, client, shared, tools, protocol, userbots | - | нет |
| Юнит/интеграция | vitest 2.1 (`apps/server/vitest.config.ts:3`, у остальных пакетов конфига нет) | server 339 файлов (~3500 тестов), client 110 (~1000, 8 skipped), shared 16, tools 4, protocol 1, userbots 0 | Mock/Slow/Scripted | temp-каталоги |
| Расширение | `node --test "apps/extension/test/*.test.mjs"` | 24 файла, настоящий Chromium (`CHROME_PATH`), `ext-harness.mjs`, `cdp-harness.mjs` | - | Chromium |
| Chromium-тесты клиента | vitest, `*.chromium.test.ts` (`skipIf(!chrome)`) | pin, dns, ssrf, web-act-e2e | - | Chromium + локальные HTTP-фикстуры |
| Стенд браузера | `node infra/bench/bench.mjs up` + `node --test "infra/bench/scenarios/*.test.mjs"` | 9 сценариев (~70 с) | ScriptedLlm | Xvfb+Chromium+HTTPS-фикстуры (облако, Linux) |
| Драйверы боевого сервера | `_jarvis_cmd.mjs`, `_jarvis_voice.mjs`, `_qa_battery.mjs`, `_qa_slow.mjs` | ручные | настоящий (подписка) | боевой 8787 |
| Живые пробы | `../_probe/live-checks/*` (вне git!) | 5 .mjs + 2 .ps1 | настоящий | Chrome владельца, MAG-монитор, `/dev/action` |
| Гейты качества | `mutate-loop.cjs`, `fn-lengths.mjs`, `module-size-gate.mjs` | ручные | - | git |

CI нет (нет `.github`, `git ls-files` не содержит workflows). `pnpm lint` пустышка. `pnpm test` = `pnpm -r test` - только vitest-пакеты.

### 1.2 Изоляция тестов сервера
`apps/server/vitest.setup.ts` (выполняется до импортов теста):
- `JARVIS_DATA_DIR` = mkdtemp (строка 13-15) - тесты не пишут в боевой `apps/server/data`;
- `JARVIS_MEMORY_REFLECT=0`, `JARVIS_CONSOLIDATION=0` - фоновые LLM-вызовы не съедают скрипт MockLlmProvider;
- `globalThis.__jarvisTestNavLookup` всегда ENOTFOUND (строка 30) - DNS-суд навигации без сети.
Тесты сами переопределяют env локально (`withEnv`, `voice-turn.ts:120`).

### 1.3 Test-support (фейки)

| Файл | Что даёт | Как подключается |
|---|---|---|
| `apps/server/src/brain/tools/test-support/fake-client.ts:29` `fakeClient` | клиент в РЕАЛЬНОЙ форме: `ui.snapshot` (handle числом), `screen.capture` с frameId, §14-гранты (`findGrant`, списание count), `denied`+`needsApproval`, `stepIndex` у `skill.execute`; журнал `sent` | `ctx.session.sendAction = fake.sendAction` |
| `apps/server/src/gateway/test-support/voice-turn.ts:73` `voiceRig` | настоящие `makeSessionContext`+`VoicePipeline`+`handleUserText`; управляемый STT (`CtrlStt.emit`), TTS теста, `SlowLlm` (задержка по ходам), `chunks` с тегом gen (mouth-to-ear), `say(text)` = wake + финал | dev-сессия `test-driver` |
| `apps/server/src/integrations/test-support/scripted-sdk.ts:54` `scriptedSdk` | поддельный Agent SDK: сценарий шагов `{tool|text}` общий на все `query()`, tool_use идёт в НАСТОЯЩИЙ MCP-хендлер, usage ∝ истории (дефект L-6) | `SdkModule` в `subscription-llm` |
| `apps/client/main/test-support/fake-sidecar.ts:131` | сайдкар UIA в форме `Ipc.cs` (ground плоско, `ControlType.X`, window.list в z-порядке), журнал; мутации `{success:true}`; неизвестная операция - ошибка как у C# | `vi.mock("../actuators/sidecar-client.js")` |
| `fake-capturer.ts:61`, `electron-mock.ts:38`, `act-mocks.ts:17` | electron (clipboard, BrowserWindow, screen с scale, powerMonitor, desktopCapturer), кадры с "провенансом" (`provOf`), OCR-слова (`ocrSees`), состояние `act` | `vi.mock("electron")` |
| `server-link.ts:37` `linkServerToClient` | настоящий серверный `dispatchTool` <-> настоящий клиентский `dispatch` в области `serverExecutor`; JSON туда-обратно (как WS); журнал `asked` (что ушло в сайдкар ДО вопроса) | мок electron+сайдкар в тесте |
| `jb-fixtures.ts` | настоящий `JarvisBrowser`+Chromium, `fixtureLookup` (DNS-таблица, `rebind*` = публичный->127.0.0.1), HTTP-фикстуры с журналом запросов | `CHROME_PATH` / `/opt/pw-browsers/chromium` / Chrome владельца |
| `xvfb-frames-smoke.ts` | настоящий Electron под Xvfb: красная метка -> центроид -> `toDipPoint`, масштабы 1/1.5/2 | esbuild+electron через `frames-xvfb.test.ts` |
| Продакшн-классы-фейки | `MockLlmProvider` (`integrations/llm.ts:204`), `Mock{Stt,Tts}Provider`, `HashEmbeddingProvider`, `InMemoryEpisodicMemory`, `MockWebProvider`, `MockSender` (userbots), `MockSpeakerVerifier`, `FakePaymentProvider`, `MockMarketDataProvider`, `StubEtaProvider` | DI в `BrainProviders` |

### 1.4 Стенд `infra/bench` (браузерный, Linux/Xvfb)
Поток: `bench up` (Xvfb :99 -> openbox -> HTTPS-фикстуры на настоящих хостах §14 из `sites/hosts.json` -> сервер `node --import tsx` с `server.env`, чистым окружением, `DATABASE_URL=pglite://`, `STT_PROVIDER=mock`, `JARVIS_SUBSCRIPTION_FALLBACK=0` -> Chromium `--load-extension`, `--host-resolver-rules`, CDP 9223) -> `POST /dev/bench/tool|say` (`gateway/bench/bench-routes.ts:36`). Bench-сессия (`clientVersion:"bench"`) - dev-изоляция, §14 отвечает `BenchSocket` по политике вызова (`"yes"|"no"|[...]`, AsyncLocalStorage), ActionCommand ПК - честный отказ. Проверка по ФАКТАМ фикстур (`message_sent`, `payment`, `order_placed`, `login_submit`...), не по словам модели. `defects.mjs` - известные дефекты как `todo`.
Порты зашиты: 8787 (в расширении), :99, 443, 8790, 9223 - один стенд на контейнер. Полный vitest параллельно не гонять (4 CPU).

### 1.5 Драйверы
- `_jarvis_cmd.mjs` (90 строк): WS `JARVIS_WS_URL`, `client.hello{token:dev, clientVersion:"cmd-test"}` -> `dev.text` с паузой 11 с; `ping->pong`; `user.confirm.request` -> AUTO-APPROVE; `action.command` -> ЧЕСТНЫЙ отказ `ok:false runtime` (`_jarvis_cmd.mjs:75-88`). Таймаут 130 с.
- `_jarvis_voice.mjs` (144 строки): фраза -> Yandex TTS lpcm 16k (нужен `YANDEX_API_KEY`) -> `audio.vad wake_local` + `speech_start` -> `audio.frame` по 20 мс в реальном темпе + 0.8 с тишины -> `speech_end`; печатает transcript, chat, `first_answer` (конец речи -> первый звук). `confirm` -> отказ. Действия не исполняет.
- `_qa_battery.mjs`/`_qa_slow.mjs`: батарея из `_qa_cmds*.json`, латентность; confirm по regex "избранн"; **action.command -> ok:true (дефект)**.
- `../_probe/live-checks/`: `dev.mjs` (dev-HTTP curl), `w1-live.mjs` (браузерные руки в Chrome владельца через `/dev/bench/*`), `w2-client-rubezh.mjs` (клиентский рубеж через `/dev/action`, ТОЛЬКО MAG), `w3-check.mjs` (один ход + чтение metrics.jsonl), `b14-webact.mjs`, `s12-probe.mjs` (/ext admission), `gui.ps1`/`chrome-win.ps1` (снимок окон/мониторов). Все требуют боевого сервера и токена из `.env`; часть - только после "сейчас можно".

### 1.6 Гейты
- `mutate-loop.cjs [имя|all] [отчёт.json]`: 17 мутаций (якоря без отступа, поиск по `src/brain/agent/index.ts` + `loop/*.ts` + `act-steps*.ts`), на каждую - `npx vitest run src/brain/agent <act-steps.test.ts> --reporter=json`, восстановление файла из копии в памяти + обработчик SIGINT/SIGTERM. Отчёт - в tmp ОС. Эффект: "какие тесты упали на какой поломке". Якоря проверены чтением: 13 из 14 просмотренных найдены ровно 1 раз (дрейфа на 29.09 не видно), но проверки актуальности нет.
- `fn-lengths.mjs [мин=150] [каталог=src/brain/agent]`: регекс-парсер скобок, печатает функции длиннее порога.
- `module-size-gate.mjs <BASE> [--allow p]... [--json]`: по `git diff` + untracked: новый .ts <=150, раздутый не растёт, врезка <=+5; тест `module-size-gate.test.mjs` (`judge`, `isGatedModule`).
- `node --test infra/client-keeper.test.mjs` - супервизор клиента.

### 1.7 Законы (нельзя нарушать, из CLAUDE.md)
Тест ценен, только если падает на сломанной реализации (реверт-проверка из СОХРАНЁННОЙ копии, не `git checkout/stash`); живой смоук обязателен для звука/GUI/расширения; агентов <=3; один флаг - одно решение; проводку проверять ПЕТЛЁЙ `handleUserText`; время в тесте - только инъекцией часов (урок runner-3, CHANGELOG 2026-09-27).

## 2. ВОЗМОЖНОСТИ (28, подробно в JSON)

| id | Что | Точка входа | Нужно |
|---|---|---|---|
| vitest-server-suite | 339 файлов | `apps/server/vitest.config.ts:3` | fake-llm |
| vitest-setup-isolation | temp DATA_DIR, отключённые фоновые LLM, DNS без сети | `vitest.setup.ts:13` | - |
| vitest-client-suite | 110 файлов | `apps/client/package.json:14` | fake-desktop |
| vitest-packages-suites | shared/tools/protocol | `packages/shared/package.json:9` | - |
| extension-node-test | 24 файла на Chromium | `apps/extension/test/ext-harness.mjs` | chrome |
| fake-client-server / voice-turn-rig / scripted-sdk | серверные стенды | см. 1.3 | - |
| client-fake-sidecar / client-fake-capturer / server-client-link | клиентские стенды | см. 1.3 | fake-desktop |
| jb-fixtures-chromium | 4 chromium-теста клиента | `jb-fixtures.ts` | chrome |
| xvfb-frames-smoke | реальный Electron под Xvfb | `frames-xvfb.test.ts:61` | hardware (liveOnly) |
| bench-stack / bench-dev-routes / bench-scenarios | стенд браузера | `infra/bench/bench.mjs` | chrome, fake-llm |
| text-driver / voice-driver / qa-battery-drivers | WS-драйверы | корень | real-brain, audio-replay |
| dev-http-endpoints | `/dev/say`, `/dev/vad`, `/dev/action`, `/dev/bench/*` | `gateway/server.ts:469-510` | liveOnly |
| live-probes | `_probe/live-checks` | вне git | owner, liveOnly |
| mutate-loop / fn-lengths-gate / module-size-gate | гейты | `apps/server/scripts` | - |
| client-keeper-test / typecheck | инфра | | - |
| hearing-corpus-test / e5-real-embedder-test | тесты с реальными весами | skipIf без моделей | audio-replay / hardware |

## 3. ШВЫ (seams)

| Шов | Где | Как подменить |
|---|---|---|
| Данные | `vitest.setup.ts:13` | mkdtemp на прогон |
| LLM | `integrations/llm.ts:204`, `gateway/bench/scripted-llm.ts:68` | Mock/Slow/Scripted; `scriptedSdk` для подписочного пути |
| STT/TTS | `voice-providers.ts:217,262,278,326` | Mock*, `CtrlStt` |
| Эмбеддинги/память | `openai-embeddings.ts:96`, `episodic.ts:372` | Hash, InMemory, PGlite |
| Клиент ПК | `fake-client.ts`, `BenchSocket`, `_jarvis_cmd.mjs` | fakeClient / честный отказ |
| Сайдкар/electron | `client/main/test-support/*` | vi.mock + fakeSidecarModule |
| Chrome | `infra/bench/chrome.mjs`, `jb-fixtures.ts` | Chromium+фикстуры, host-resolver-rules |
| DNS | `vitest.setup.ts:30`, `fixtureLookup` | ENOTFOUND / таблица |
| Время | нет общего шва | per-class `now:()=>number` (throttle, billing, checkpoint-store, warmth, cadence, resend-guard, response-cache, TaskManager) + `vi.useFakeTimers` (28 файлов) |
| Микрофон | `_jarvis_voice.mjs:59` | PCM-кадры в `audio.frame` (локальный KWS/VAD клиента не покрыт) |
| Процесс сервера | `infra/bench/config.mjs:69` | `cleanEnv`, `JARVIS_ENV_PATH` |

## 4. КАК ПРОВЕРЯТЬ БЕЗ ЧЕЛОВЕКА

| Возможность | Хватает ли | Что нужно | Не покрыто |
|---|---|---|---|
| Гейты §14/SSRF/honesty (сервер) | юнит+fakeClient+petля | fake-llm | реальные клиентские актуаторы |
| Петля, нуджи, каскад тиров | MockLlm/ScriptedLlm + `mutate-loop` | fake-llm | поведение НАСТОЯЩЕЙ модели (качество решений) |
| Голосовой ход (pipeline, barge-in, first_answer) | `voiceRig`, `SlowLlm` | fake-clock | wake/KWS/VAD клиента на живом звуке, эхо, AEC |
| Браузерные руки | bench (Linux/Xvfb) + расширение node:test | chrome | реальные сайты, Chrome владельца, Telegram/Gmail |
| Клиентский рубеж/актуаторы GUI | fakeSidecar+electron-mock, `linkServerToClient` | fake-desktop | реальный UIA/SendInput/Core Audio (liveOnly: MAG-пробы w2) |
| Кадры экрана/координаты | xvfb-frames-smoke | hardware | Windows DPI, мульти-монитор |
| Слух (sherpa) | `sherpa-hearing.test.ts` с корпусом WAV | audio-replay + модели | живой микрофон |
| Проактив (напоминания, наблюдения, сон-цикл) | юниты с инъекцией `now` | fake-clock | сквозные сутки; общего шва нет |
| Подписочный мозг | `scriptedSdk`; `_jarvis_subscription_check.mjs` живьём | real-brain | лимиты подписки, реальные сессии SDK |
| Память e5 | `lms-quiz-recall-e5.test.ts` (DML win32) | hardware | молча пропускается без весов |
| Продукт-каркас | `FakePaymentProvider`, `/dev/product/*` | db | реальная оплата |

## 5. ВРЕМЯ ПРОГОНА (не замерено - оценки, требуют калибровки лабораторией)

| Этап | Оценка | Основание |
|---|---|---|
| typecheck 6 пакетов | 1-2 мин | tsc strict, ~450 файлов, инкрементальности нет |
| vitest server | 3-6 мин | 3500 тестов, 339 файлов, 11 файлов с sleep >=100 мс |
| vitest client | 1-2 мин | ~1000 тестов; 3x подряд гонялся в CHANGELOG 2026-09-27 |
| vitest shared+tools+protocol | <30 с | 21 файл |
| extension node:test | 1-2 мин | 24 файла, каждый поднимает Chromium |
| chromium-тесты клиента | 1-2 мин | 4 файла, `beforeAll` до 60 с |
| bench (up+сценарии) | 2-3 мин | README: сценарии ~70 с + подъём стека |
| module-size-gate + fn-lengths | <10 с | |
| mutate-loop all | 15-40 мин | 17 x полный `src/brain/agent` без `--bail` |
| live-пробы | минуты, только владелец | |

Известные флейки: (1) `jarvis-browser-pin.chromium.test.ts:25` - живой `example.com` + top-level await DNS; (2) runner-3 (закрыт 27.09, урок: не `>= t0+N` на реальных таймерах); (3) тесты с sleep/setTimeout >=100 мс в 11 файлах под нагрузкой; (4) конкуренция за CPU при параллельном vitest+bench. Флейк-скана нет.

## 6. Предложение: `pnpm verify`

Профили, единый раннер `infra/lab/verify.mjs` (новый), вывод JSON + сводка, длительности пишутся в `docs/lab/runs/<дата>.json`:

**verify:quick (цель <=4 мин, каждое изменение)**
1. `pnpm -r typecheck`
2. `vitest run --changed <BASE>` для server/client (плюс полный `packages/*`)
3. `node apps/server/scripts/module-size-gate.mjs origin/main`
4. `node --test infra/client-keeper.test.mjs apps/server/scripts/module-size-gate.test.mjs`
5. skip-аудит: список пропущенных с причинами

**verify (цель 10-15 мин, перед PR)**
1-3 как выше, но `vitest run` полностью (server, client, packages) + `node --test "apps/extension/test/*.test.mjs"` (при наличии `CHROME_PATH`; иначе FAIL, не skip) + hermetic-режим (запрет сети) + `fn-lengths` на `src` (порог 150) + скан флейков: изменённые тест-файлы x5 повторов (`vitest run <файлы> --repeat 5` или `--retry 0` в цикле).

**verify:full / nightly (30-60 мин)**
все шаги verify + bench (`up`, сценарии, `down`) + `mutate-loop all` с валидатором якорей (падает на "anchor not found") + полный vitest x3 для флейк-скана + сравнение с прошлым прогоном (новые skip, рост времени >20%).

**Вне verify (liveOnly, только владелец/"сейчас можно")**: w1-live, w2-client-rubezh, w3-check, b14-webact, s12-probe, `_jarvis_voice.mjs`.

## 7. Новое vs переиспользовать

Переиспользовать как есть: `fakeClient`, `voiceRig`, `scriptedSdk`, `linkServerToClient`, `fake-sidecar`, `electron-mock`, `jb-fixtures`, `infra/bench` (стек, фикстуры, `BenchSocket`, `ScriptedLlm`, `script-refs`), `_jarvis_cmd.mjs` (после починки доков), `module-size-gate`, `mutate-loop`.
Лаборатория должна быть НОВОЙ там, где сегодня пусто: (а) единый раннер и отчёты (сейчас 4 несвязанные команды + ручные скрипты); (б) десктоп-стенд - настоящий клиент как `/ws`-клиент с fake-desktop вместо честного отказа; (в) общий шов времени; (г) динамические порты/изоляция сессий; (д) аудио-реплей без Yandex; (е) hermetic-сеть и skip-аудит; (ж) перенос `_probe/live-checks` в репозиторий (`infra/lab/live/`) с параметризацией путей/токена; (з) покрытие мутациями за пределами петли.

## 8. ДЕФЕКТЫ/ДОЛГ

| Сер. | Где | Что |
|---|---|---|
| high | `_qa_battery.mjs:56`, `_qa_slow.mjs:37` | `action.result ok:true` - ложный успех актуатора (закон 1; `_jarvis_cmd.mjs` это убрал 01.09) |
| high | `_qa_battery.mjs:4`, `_qa_slow.mjs:5` | 8787 захардкожен - прогон идёт в боевой сервер |
| high | `docs/HOW_IT_WORKS.md:69,35` | учит "фейковый ok:true" и цифре "~613 тестов" (реально ~3500) |
| high | `jarvis-browser-pin.chromium.test.ts:25,87` | живая сеть в наборе (example.com), top-level await DNS |
| med | `mutate-loop.cjs:15` | дрейф якорей -> тихая строка "anchor not found"; 17 мутаций только для петли; два якоря на одной строке `tool-classify.ts:178` |
| med | `mutate-loop.cjs:64` | нет `--bail`/параллелизма, десятки минут |
| med | `package.json:11` | `pnpm test` не включает расширение, keeper, gate, bench; `lint` пустой; CI нет |
| med | `apps/server/vitest.config.ts:3` | нет include/exclude/timeout/retry; из корня подхватит `.claude/worktrees/*` |
| med | `lms-quiz-recall-e5.test.ts:19`, `frames-xvfb.test.ts:61` и др. | молчаливые skip (клиент 8 skipped); зелёный != проверено |
| med | `infra/bench/README.md:96` | порты зашиты - параллельные лаборатории невозможны |
| med | `infra/bench/README.md:60` | десктоп-стенда нет, GUI-инструменты в облаке не проверяются |
| low | `fn-lengths.mjs:1`, `module-size-gate.mjs:1` | регекс-парсер; gate требует BASE; не подключены к verify |
| low | `../_probe/live-checks/*` | вне git, абсолютные `C:/Users/anton/...` |
| low | корень jarvis | мусор `_lay_test.log`, `test_*.mjs`, `_qa_out.txt`, ~60 mp3 |
| low | `voice-turn.ts:97` | `as unknown as Session/BrainProviders` - дрейф формы не ловится типами |

Не найдено: записанных времён прогона, отчётов о флейках кроме runner-3, конфигурации CI, `vitest.config` у клиента и пакетов (используются дефолты).
