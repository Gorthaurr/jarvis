# Харнесс инструментов лаборатории

Агент зовёт ЛЮБОЙ инструмент Джарвиса через НАСТОЯЩИЙ серверный `dispatchTool` (гейты §0/§14, SSRF, фасады
`look/window/audio`, разбор результата), а клиентом ПК служит `FakeDesktop`. Видно, что произошло: ответ модели, заданные
владельцу вопросы, ушедшие клиенту команды, эффекты на «ПК» и его итоговое состояние. Боевой Джарвис не затрагивается:
данные в `%TEMP%\jarvis-lab\tool-*`, PGlite/память в процессе, веб и DNS — из seed/таблицы.

## Из кода

```ts
import { createToolLab } from "./harness.js";
const lab = createToolLab({ seed: { files: { "C:/a.txt": "x" } }, confirm: "yes" });
const r = await lab.call("fs_delete", { path: "C:/a.txt" });
// r.text / r.isError / r.flags (sent, declined, uncertain...) / r.asked (§14) / r.actions / r.effects / r.snapshot / r.ms
await lab.close();
```

- `confirm` — `ConfirmPolicy` (`yes|no|expire|undelivered`, массив по очереди, функция). По умолчанию `"no"`: необратимое
  само не выполняется. Массив кончился — отказ с пометкой `overflow`, не тихое «да».
- Команда и результат идут через JSON (как по WS): `undefined`/BigInt/циклы проявляются здесь. Чужой `commandId` или
  зависший обработчик — честные `runtime`/`timeout`, а не подправленный успех.
- `ctx: { ext, mcp, market, knowledge, ... }` подключает недостающие части ToolContext (мок). Без них инструменты, которым
  нужен внешний мир (Chrome-расширение, MCP, рынок, SMTP, `self_patch`), НЕ вызываются: результат с
  `notVerifiable: "<причина>"` и `isError` (`limits.ts`). Кейс может ожидать это: `expect.notVerifiable`.
- Изоляция (`isolation.ts`) импортируется первой: `JARVIS_DATA_DIR`/`DATABASE_URL` смотрят в каталог прогона или в
  каталог-сторож в `%TEMP%`, никогда в данные владельца. env процесса глобален → лабы в одном процессе последовательны.

## Кейсы и раннер

Кейс — данные (`case-format.ts`): инструмент + аргументы + seed «ПК» + ожидания ПО ФАКТУ. Правила и шаблон — в
`cases/README.md`; образцы — `cases/sample.cases.ts`.

```
node --import tsx infra/lab/tools/cli.ts [--json] [--filter <подстрока id>] [--tool <coversTool>]
node_modules/.bin/vitest run --root infra/lab tools/          # то же через vitest (describeCases)
```

Код выхода 1 при fail/error. Кейс, которому нужен вид команд, что FakeDesktop не умеет, ПРОПУСКАЕТСЯ с причиной
(`skip`, не зелёное) и оживает сам, когда обработчик появится.

## Матрица покрытия

`node --import tsx infra/lab/coverage/cli.ts --write` пересобирает `docs/lab/COVERAGE.md` (`pnpm lab:coverage`).
Кейс засчитывается в покрытие только если он ПРОШЁЛ; сценарий `liveOnly` ничего не доказывает.
