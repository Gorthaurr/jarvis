# pnpm verify — единый раннер проверок

Один вход вместо четырёх несвязанных команд и ручных скриптов. Раннер запускает шаги как дочерние процессы, собирает
сводку (имя, статус, время, счётчики тестов, пропущенные тесты С ПРИЧИНАМИ) и пишет JSON в `docs/lab/runs/`.
Исходники: `infra/lab/verify.ts` (вход), `infra/lab/verify/*` (шаги, разбор, отчёт), `infra/lab/flake/*` (флейк-скан).

```
pnpm verify:quick     # каждое изменение, цель ≤ 4 мин
pnpm verify           # перед PR, 10–15 мин
pnpm verify:full      # ночной, 30–60+ мин
# то же напрямую и с флагами:
node --import tsx infra/lab/verify.ts --profile quick|verify|full [--json] [--only id,префикс] [--base REF] [--out DIR] [--list]
```

Код выхода: `0` — нет FAIL; `1` — есть FAIL; `2` — ошибка аргументов. `--json` печатает отчёт в stdout (прогресс — в stderr).
`--only` гоняет часть шагов и без `--out` НЕ пишет отчёт в `docs/lab/runs` (частичный прогон не должен становиться «прошлым»).

## Статусы и «зелёный ≠ проверено»

Шаг: `pass` / `fail` / `skip`. `skip` бывает только с причиной (нет Xvfb, не Linux) и не валит прогон, но попадает в аудит.
Аудит в конце сводки перечисляет то, что зелёный статус НЕ доказал: пропущенные шаги, пропущенные/todo-тесты, набор из
0 тестов (`--changed` ничего не нашёл; в `userbots` тестов нет вовсе). vitest не пишет причину пропуска, поэтому причина
берётся из исходника теста (`skipIf(...)` и т.п. с `файл:строка`); не нашли — так и написано, ничего не выдумываем.

Пустой набор тестов — FAIL, кроме `--changed` и `userbots` (там это явно разрешено и вынесено в аудит). Упавший целиком файл
(ошибка импорта) — FAIL, даже если «упавших тестов» ноль. Шаг без итоговых строк (`# pass N`, JSON vitest) — FAIL.

## Профили

Профили вложены: quick ⊂ verify ⊂ full (кроме замены `--changed` на полный набор).

| Шаг | quick | verify | full | Что проверяет |
|---|:-:|:-:|:-:|---|
| `typecheck:<server\|client\|shared\|tools\|protocol\|userbots\|lab>` | + | + | + | `tsc --noEmit` пакета (параллельно) |
| `gate:module-size` | + | + | + | `module-size-gate.mjs` против `origin/main` (модули ≤150, раздутые не растут) |
| `node-test:keeper` | + | + | + | `node --test infra/client-keeper.test.mjs` |
| `vitest:gate-test` | + |  |  | тест гейта размеров (это vitest-файл — под `node --test` он падает) |
| `audit:only-skip` | + | + | + | нет закоммиченных `.only` (молча сужают набор); число мест skip |
| `vitest:server:changed`, `vitest:client:changed` | + |  |  | `vitest --changed <base> --passWithNoTests` из каталога пакета |
| `vitest:shared/tools/protocol/userbots` | + | + | + | пакеты целиком (секунды) |
| `vitest:server`, `vitest:client` |  | + | + | полные наборы |
| `vitest:lab` |  | + | + | тесты лаборатории (`--root infra/lab`) |
| `node-test:extension` |  | + | + | 24 файла на настоящем Chromium; **без `CHROME_PATH` — FAIL** с причиной, не skip |
| `fn-lengths` |  | + | + | длина функций, «храповик» (см. ниже) |
| `flake:changed` |  | + | + | изменённые тест-файлы ×5 |
| `mutate:anchors` |  | + | + | каждый якорь `mutate-loop.cjs` найден ровно один раз (секунды) |
| `mutate:loop` |  |  | + | `mutate-loop all` (15–40 мин); отчёт разбирается: `anchor not found` / `not unique` / поломка vitest = FAIL |
| `bench` |  |  | + | `infra/bench` (up → сценарии → down всегда); не Linux или нет Xvfb — skip с причиной |
| `flake:full` |  |  | + | полные прогоны vitest ×3 по пакетам и лаборатории |
| `compare:previous` |  |  | + | сравнение с прошлым `full`: новые skip и рост времени шага >20% (шаги <10 с — шум) = FAIL |

Таймаут — у каждого шага (`--list` показывает); процесс убивается вместе с деревом (`taskkill /T /F` на Windows).
Вывод дочерних процессов усечён (в памяти — хвост 2 МБ, в отчёте у упавшего шага — последние 3000 символов).

## Что вне verify (только владелец, «сейчас можно»)

`_probe/live-checks/*` (w1-live, w2-client-rubezh, w3-check, b14-webact, s12-probe), `_jarvis_voice.mjs`, GUI на MAG. Тесты
«зелёные» ≠ «проверено живьём» для звука, GUI и расширения — закон проекта.

## Флейк-скан (`infra/lab/flake/`)

Набор прогоняется K раз, по каждому тесту исход «стабильно / нестабильно (n из K)». Пропуск (skipped) нестабильностью не
считается. Упал во всех прогонах — «сломан», не флейк. Нестабильный тест из `flake/known.ts` (данные: подстрока ключа +
причина) не валит прогон, но всегда виден в notes; новый нестабильный — FAIL. Прогон без отчёта vitest — FAIL.
Изменённые тест-файлы берутся из `git diff <base>` + неотслеживаемые; `.mjs` под `node --test` (расширение) скан не
покрывает — это записывается в аудит.

## fn-lengths: храповик, а не порог

В `apps/server/src` уже 11 функций длиннее 150 строк (долг: `createGateway`, `makeSessionContext`, `dispatchToolCore`, …).
Красный порог навсегда бесполезен, поэтому долг зафиксирован в `infra/lab/verify/fn-baseline.json` (`файл::функция` →
строк). FAIL — только новая длинная функция или рост старой. Усохла/исчезла — шаг зелёный и просит обновить baseline.

## Отчёт `docs/lab/runs/<YYYYMMDD-HHMMSS>.json`

`{version, profile, startedAt, finishedAt, ms, base, host, ok, steps[], audit}`; шаг: `{id, title, status, reason?, ms,
exitCode, timedOut, tests{total,passed,failed,skipped,todo}, skipped[{file,name,reason}], notes[], unverified[],
outputTail?}`. JSON-файлы в git не попадают (`docs/lab/runs/.gitignore`): сравнение с прошлым прогоном работает локально
на машине, где гоняют `full`; нужен как доказательство в PR — `git add -f`.

## Как добавить шаг

Шаг — объект `Step` (`verify/types.ts`): `id`, `title`, `profiles`, `timeoutMs`, `exec` (процесс: cmd/args/cwd) + `parse`
(разбор вывода → `StepOutcome`) либо `inproc` (функция), необязательные `gate` (предусловие: skip/fail с причиной до
запуска) и `group` (параллельный запуск подряд идущих). Добавь его в `steps-*.ts`; файлы ≤150 строк; тест на разбор — рядом.

## Известные пределы

- «Hermetic-режим» (запрет сети в тестах) не сделан: на `jarvis-browser-pin.chromium.test.ts` (живой example.com) остаётся
  запись в `known.ts`. Под VPN/без сети этот тест может мигать.
- Ветка `bench` написана по README стенда, но на Windows не исполнялась (только skip-путь) — проверить на Linux-контейнере.
- Выживший мутант `mutate-loop` пока попадает в аудит (`unverified`), а не в FAIL: базовой картины «все 17 убиваются» нет.
- Таймаут `mutate:loop` убивает процесс жёстко (`/F`): файл петли может остаться мутированным — проверь `git diff`.
