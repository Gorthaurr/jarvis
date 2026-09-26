# Стенд Джарвиса (браузерный, W1)

Среда, где агент **сам** вживую проверяет Джарвиса в браузере, и инструменты контроля к ней. Всё настоящее, кроме
мозга: настоящий сервер (`apps/server`, порт 8787, dev-HTTP), настоящий Chromium на Xvfb с распакованным расширением
`apps/extension`, HTTPS-фикстуры на **настоящих именах хостов** (по ним судят гейты §14), настоящий `dispatchTool` и
настоящая петля `handleUserText`. Мозг — сценарный (ключа LLM на стенде нет): последовательность ходов модели задаёт
сценарий. Проверка — **по факту**: фикстуры журналируют реальные HTTP-действия (отправлено/оплачено/заказано), а не
слова модели.

Десктопный стенд (Electron-клиент под Xvfb как настоящий `/ws`-клиент, актуаторы ПК) — следующий шаг (W2).

## Быстрый старт

```bash
pnpm install --frozen-lockfile
node infra/bench/bench.mjs setup      # apt: xvfb openbox xdotool wmctrl imagemagick tesseract(+rus) ffmpeg; проверки
node infra/bench/bench.mjs up         # Xvfb :99 → openbox → фикстуры → сервер → Chromium → ждём коннект расширения
node infra/bench/bench.mjs status     # JSON: процессы, /healthz, ext.connected, service worker, CDP, окна; ready:true
node --test --test-concurrency=1 "infra/bench/scenarios/*.test.mjs"   # сценарии (≈70 с)
node infra/bench/bench.mjs down       # гасит ТОЛЬКО свои процессы (pid-файлы), профиль Chromium стирается
```

Каталог стенда — `infra/bench/tmp/` (игнорируется git: `tmp/`), переопределение — `--dir <каталог>` или `BENCH_DIR`.
Там: `run/*.pid`, `logs/*.out.log` (xvfb, wm, sites, server, chrome), `data/` (JARVIS_DATA_DIR сервера, его JSONL-лог
`data/logs/server-YYYY-MM-DD.log`), `pgdata/` (PGlite), `ext/` (бандл расширения), `certs/`, `media/`, `shots/`,
`out/` (картинки из ответов инструментов), `server.env` (права 600, свежий dev-токен на каждый `up`), `state.json`,
`sites-events.jsonl`.

## Команды CLI (`node infra/bench/bench.mjs <команда>`)

| Команда | Что делает |
|---|---|
| `setup` | apt-зависимости (root) и проверки: бинарники, Chromium, node_modules, esbuild, tesseract rus |
| `up` / `down` / `status` | подъём/гашение/состояние стека. Порт или дисплей занят чужим — отказ, чужое не трогаем |
| `tool <name> <json\|@file> [--confirm yes\|no\|expire\|undelivered\|yes,no] [--json] [--full]` | инструмент через НАСТОЯЩИЙ `dispatchTool` bench-сессии; сводка + §14-вопросы; картинки → `out/` |
| `say "реплика" --script f.json [--confirm …] [--var k=v] [--json]` | реплика через петлю `handleUserText` со сценарным мозгом; раунды, нуджи, задача |
| `shot [file.png] [--scale 50%] [--ocr]` | скриншот экрана Xvfb (`import -window root`); `--ocr` — tesseract rus+eng |
| `log [n] [--out]` | хвост JSONL-лога сервера (форматированный) или `logs/server.out.log` |
| `sites-log [--run id] [--site s] [--facts] [--json]` | журнал фикстур (факты и трассы) |
| `reset` | журнал фикстур, вкладки (одна `about:blank` через CDP), bench-сессия (ref-снимки, цель вкладки, одобрения) |

**Смотреть экран:** `node infra/bench/bench.mjs shot --scale 50%` печатает путь к PNG — агент открывает его Read'ом.
Картинки из `browser_read{view:"image"}` CLI кладёт в `tmp/out/`.

## Как устроено

- **Сервер** стартует `node --import tsx src/index.ts` с `JARVIS_ENV_PATH=<стенд>/server.env` и ЧИСТЫМ окружением
  (без токенов/прокси агента). В `server.env` только существующие флаги: `JARVIS_DEV_HTTP=1`, `JARVIS_DEV_TOKEN`,
  `JARVIS_EXT_ID` (из `key` манифеста — `pjkeladocehklaefmnhapmmpabmaeajd`), `JARVIS_DATA_DIR`, `DATABASE_URL=pglite://…`,
  `JARVIS_SUBSCRIPTION_FALLBACK=0`, пустые `ANTHROPIC_*`, `STT_PROVIDER=mock`, выключенные ambient/диктор/дистилляция.
  **Новых `JARVIS_*` стенд не вводит.**
- **Расширение** собирается тем же esbuild, что `apps/client/scripts/build.mjs`, но в `<стенд>/ext` (в
  `apps/extension` стенд не пишет). Порт сервера зашит в расширении (`ws://127.0.0.1:8787/ext`) → один стенд на контейнер.
- **Chromium**: `--load-extension`, `--host-resolver-rules` (хосты фикстур → 127.0.0.1, всё прочее NOTFOUND — в интернет
  стенд не ходит), `--ignore-certificate-errors`, `--no-proxy-server` (иначе возьмёт прокси агента), CDP на 9223
  (только HTTP `/json/*`), профиль — временный, стирается на каждом `up`.
- **Фикстуры** (`sites/hosts.json` — один источник для резолвера, SAN сертификата и маршрутов; хост меняется строкой):

| Хост | Сайт | §14 | Факты |
|---|---|---|---|
| `web.max.ru` | мессенджер (Enter; `?mode=ctrl` — Ctrl+Enter; кнопка «Отправить») | messenger | `message_sent {text, via}` |
| `online.sberbank.ru` | банк: «Оплатить» (POST-форма), «Перевести» (fetch) | bank | `payment`, `transfer` |
| `lms.vuz-bench.ru` | Moodle: view → startattempt → attempt → summary (кнопка + модалка) → review | edu по пути | `attempt_started`, `answer_saved`, `quiz_finished` |
| `shop.example.com` | магазин: «Добавить в корзину», «Оформить заказ» | безопасный | `cart_add {qty}`, `order_placed` |
| `id.example.com` | вход: пароль, OTP (`one-time-code`) | §0 | `login_submit` (без секретов) |
| `news.example.com` | лента с таймером, «Показать ещё»; `/slow?ms=N` | безопасный | `feed_more`; трассы `slow_served`/`slow_aborted` |
| `video.example.com` | `<video>` (клип ffmpeg), autoplay НЕ отключён | безопасный | `media_play/pause/seeked/ended` |

  Каждый прогон сценария помечен `run` (`?run=` → sessionStorage + cookie хоста), факты фильтруются по нему.
  Control фикстур: `http://127.0.0.1:8790` — `GET /events?run=&site=&kind=fact|trace&type=`, `POST /reset`, `GET /health`.

## Dev-эндпоинты стенда (только `JARVIS_DEV_HTTP=1`, loopback + `x-jarvis-dev-token`)

Одна долгоживущая bench-сессия (`clientVersion:"bench"` → dev-изоляция T-F1: своя память, задачи `dev`, без
самообучения). Сокет сессии отвечает на §14 **по политике вызова** (AsyncLocalStorage): строка — на все вопросы,
массив — по ответу на вопрос, дальше отказоустойчивое «нет» (`policyOverflow`); по умолчанию `"no"`. Вопрос фоновой
задачи после конца вызова — «сирота» (`stray`), ответ «нет». ActionCommand клиенту ПК — честный отказ (клиента нет).

- `POST /dev/bench/tool {name, input, confirm?, waitExtMs?}` → `{ok, ms, result:{isError,text,content,flags,data},
  questions:[{n,kind,summary,answer,outcome}], policyOverflow, resolved, clientActions, ext, session}`.
  `ok:false` — только транспорт/ввод (409 занято, 400 неразрешённый `$ref`); успех инструмента — `result.isError`.
- `POST /dev/bench/say {text, script:{turns}, confirm?, timeoutMs?, deps?:{skills:true}}` → `{final, chat, rounds,
  llm:{loopCalls,sideCalls,scriptTurns,exhausted,extraLoopCalls}, questions, stray, task, timedOut}`.
  `llm.loopCalls==0` — реплику закрыл tier0/кэш без модели (сценарий обязан считать это провалом).
- `GET /dev/bench/state`, `POST /dev/bench/reset`.

**Сценарий `say`** — ходы модели: `{"turns":[{"text":"…","tool_uses":[{"name":"browser_open","input":{…}}]}, …,
{"text":"Финал."}]}`. Плейсхолдеры во входах (и в `tool`): `"$ref:<подпись>"` — ref элемента из снимков
`browser_inspect` (свежий первым, точная подпись важнее вхождения), `"$match:<regex>"` — группа из последнего
результата; `{{var}}` подставляет клиент (`--var`). Побочные вызовы LLM (без `sessionKey`: рефлексы, prefill,
противоречия памяти) получают стаб и сценарий не тратят. **Нуджи петли** (verify-долг, goal-check после «Открыл…»/
мутации) — это лишние ходы модели: сценарий должен их учитывать (повторить финал), иначе `exhausted:true` и честный
стаб-терминал. Финал проходит вербализацию (числа → слова) — сравнивайте тексты без цифр.

## Сценарии и `lib.mjs`

`scenarios/*.test.mjs` поднимают стенд при необходимости (`ensureUp`, остаётся жить), берут межпроцессный замок
(`lock`), сбрасывают состояние (`begin`), работают каждый со своим `run`. API: `tool`, `say`, `open(url)` (свежие вкладки
+ ожидание коммита навигации), `facts/waitFacts/traces`, `cdp.{list,pages,close,newTab}`, `shot`, `reset`.
«Ничего не произошло» проверяется ожиданием 1,5 с.

**Найденные дефекты Джарвиса** (`scenarios/defects.mjs`) — тесты честные, но помечены `todo` («ждёт фикса W1»): прогон
их показывает, но не краснеет. Починили — удалите запись, тест станет сторожем фикса.

## Ограничения

- Один стенд на контейнер: 8787 (зашит в расширении), :99, 443, 8790, 9223. Полный `vitest` сервера параллельно со
  стендом не гонять (4 CPU).
- Мозг сценарный: качество решений модели стенд не проверяет — только проводку, гейты, честность инструментов и факты.
- Клиентских актуаторов нет (W1): GUI-инструменты и `/dev/action` в bench-сессии честно отказывают; bench-сессия
  видна в `registry` (`/dev/action` берёт последнюю сессию — на стенде это она).
- Эмбеддер e5 может не скачаться (у Node нет прокси) — память/семантический дубль-гейт деградируют, для §14 и браузера
  не важно.
- MV3 service worker засыпает: `/dev/bench/tool` ждёт коннекта расширения до 5 с (`waitExtMs`).
- Chromium показывает инфобар «неподдерживаемый флаг» (`--host-resolver-rules`) — страницы сдвинуты вниз на ~30 px.
- `node --test` в Node 22 принимает глоб, не каталог: `"infra/bench/scenarios/*.test.mjs"` в кавычках.
