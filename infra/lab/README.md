# Лаборатория Джарвиса: сервер, клиент, CLI

Агент Claude сам поднимает ИЗОЛИРОВАННЫЙ настоящий сервер, подключает настоящего WS-клиента с виртуальным ПК (FakeDesktop)
и смотрит, что произошло. Боевой Джарвис владельца (порт 8787, его процессы, `apps/server/data`, его `.env`) не затрагивается.

## CLI (из корня репозитория)

```
node --import tsx infra/lab/lab.ts up [--brain off|real] [--stt mock|deepgram] [--port N]
node --import tsx infra/lab/lab.ts say "открой блокнот" [--confirm yes|no|expire|undelivered|yes,no] [--seed файл.json] [--wait-tasks] [--fresh]
node --import tsx infra/lab/lab.ts status
node --import tsx infra/lab/lab.ts log [n]
node --import tsx infra/lab/lab.ts metrics
node --import tsx infra/lab/lab.ts down [id|all] [--keep]
```

- `up` печатает `{id, port, dir, pid, token}` и оставляет сервер жить (реестр: `%TEMP%\jarvis-lab\state.json`).
  Порт 8811..8899, данные и PGlite в `%TEMP%\jarvis-lab\<id>`, мозг `off` (ход честно отвечает «связь прервалась»).
- `say` печатает `{turn, decisions, desktop}`: `TurnResult` (чат, действия с результатами, вопросы §14, задачи, карточки,
  состояния, ошибки сервера) и итоговый снимок FakeDesktop. Последовательные `say` делят одного пользователя (память);
  `--fresh` — чистая партиция. Серверов несколько — `--server <id>`.
- `--brain real` идёт по подписке владельца и тратит общий лимит; токен пробрасывается только в env процесса сервера.
  `--brain scripted` не поддержан (см. ниже).
- `down` гасит только процессы с меткой `--lab-id=<id>` в командной строке; каталог удаляется, если нет `--keep`.

## Из кода

```ts
const server = await startLabServer({ brain: "off" });          // infra/lab/lib/server.ts
const desktop = createFakeDesktop();                            // infra/lab/desktop
const client = await connectLabClient({ server, desktop, confirm: ["yes", "no"], faults: [{ kind: "fs.read", mode: "error", times: 1 }] });
const turn = await client.say("привет", { waitTasks: true });   // TurnResult
await client.close(); await server.stop();
```

Faults клиента: `error` (отказ без обращения к desktop), `timeout` (клиентский timeout-ответ), `slow` (`ms`), `drop_socket`
(обрыв, resume, результат уходит из outbox после возврата). Политика §14: `yes|no|expire|undelivered`, массив по очереди
(кончился — «no» с пометкой `overflow` в `client.decisions()`), функция `(summary, kind, n)`.

## Что нужно знать

- Клиент называется `lab-1.0` (полная, не dev-сессия; UUID-токен = своя партиция памяти). После hello он ждёт ~1,5 с,
  чтобы онбординг сервера не попал в первый ход (`settleMs: 0` отключает; dev-имя клиента онбординга не получает).
- Сервер не сериализует кадры, поэтому `say` внутри клиента строго последовательны.
- Тесты: `node_modules/.bin/vitest run --root infra/lab lib/` (живой прогон ~30 с; `LAB_SKIP_LIVE=1` пропускает его).
