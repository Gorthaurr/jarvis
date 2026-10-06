# Матрица покрытия лаборатории

Сгенерировано 2026-09-29 командой `node --import tsx infra/lab/coverage/cli.ts --write` — руками не править.
Строки собираются из КОДА (схемы инструментов, ActionCommand, LocalIntent tier0); «чем покрыто» — grep тестов, кейсы инструментов лаборатории, `covers` сценариев, `liveOnly` из docs/lab/map.

Колонки: **U** unit, **I** integration (эвристика по пути теста), **T** кейс инструмента лаборатории (прошёл), **S**/**R** сценарий scripted/real-мозгом, **L** только живьём, **ПК** — FakeDesktop умеет этот вид команд.

## Итого

Строк: **179** (инструментов 113, видов команд 59, интентов 7).

| Чем покрыто | Строк |
|---|---|
| unit | 120 |
| integration | 75 |
| кейсы инструментов | 25 |
| сценарии (scripted) | 0 |
| сценарии (real) | 0 |
| хоть чем-то из лаборатории | 25 |
| только живьём | 36 |
| НЕ покрыто | 29 |

FakeDesktop умеет 59 из 59 видов команд.

## Не покрыто ничем (29)

- `tool:app_close`
- `tool:cancel_reminder`
- `tool:consent_list`
- `tool:consent_revoke`
- `tool:demo_record`
- `tool:market_backtest`
- `tool:market_candles`
- `tool:market_news`
- `tool:monitor_assign`
- `tool:monitor_list`
- `tool:monitor_set`
- `tool:obligation_add`
- `tool:obligation_list`
- `tool:obligation_remove`
- `tool:tool_create`
- `tool:tool_list`
- `tool:tool_remove`
- `tool:trade_predictions`
- `tool:watch_cancel`
- `tool:watch_list`
- `tool:window_arrange`
- `action:demo.record`
- `action:fs.edit`
- `action:fs.mkdir`
- `action:fs.move`
- `action:jbrowser.open`
- `action:monitor.assign`
- `action:monitor.list`
- `action:monitor.set`

## Только живьём, без покрытия в тестах и лаборатории (10)

- `tool:audio_sessions` — Кто звучит: Core Audio сессии по процессам с пиком
- `tool:audio_set` — Точечный мьют/громкость приложения
- `tool:browser_sync_login` — Перенос логинов: cookies.export расшифрованными из Chrome в невидимый браузер
- `tool:screen_selection` — Режим выделения: start/view/clear, вуаль, свежий кадр области
- `tool:system_layout` — Переключение раскладки foreground-окна с readback
- `tool:system_media` — Медиа-клавиши, state по WASAPI peak, pause только при звуке
- `action:audio.sessions` — Кто звучит: Core Audio сессии по процессам с пиком
- `action:jbrowser.import_cookies` — Импорт кук из расширения в браузер Джарвиса
- `action:jbrowser.login` — Открыть видимое окно входа в общий профиль
- `action:obs.request` — Запрос obs-websocket v5

## Инструменты

| Инструмент | U | I | T | S | R | L | Причина live-only |
|---|---|---|---|---|---|---|---|
| `act` | + | + |  |  |  |  |  |
| `app_channel_forget` | + |  |  |  |  |  |  |
| `app_channel_learn` | + | + |  |  |  |  |  |
| `app_channels` | + | + |  |  |  |  |  |
| `app_close` |  |  |  |  |  |  |  |
| `app_focus` | + | + |  |  |  |  |  |
| `app_launch` | + | + | + |  |  |  |  |
| `audio` |  | + |  |  |  | + | Фасад звука по приложениям: list->audio_sessions, set->audio_set |
| `audio_sessions` |  |  |  |  |  | + | Кто звучит: Core Audio сессии по процессам с пиком |
| `audio_set` |  |  |  |  |  | + | Точечный мьют/громкость приложения |
| `browser_act` | + | + |  |  |  |  |  |
| `browser_batch` | + | + |  |  |  |  |  |
| `browser_close` | + | + |  |  |  |  |  |
| `browser_inspect` | + | + |  |  |  |  |  |
| `browser_open` | + | + |  |  |  |  |  |
| `browser_read` | + | + | + |  |  |  |  |
| `browser_sync_login` |  |  |  |  |  | + | Перенос логинов: cookies.export расшифрованными из Chrome в невидимый браузер |
| `browser_tabs` | + | + |  |  |  |  |  |
| `calendar_read` | + |  |  |  |  |  |  |
| `cancel_reminder` |  |  |  |  |  |  |  |
| `code_run` | + | + |  |  |  |  |  |
| `consent_list` |  |  |  |  |  |  |  |
| `consent_revoke` |  |  |  |  |  |  |  |
| `context_read` | + |  |  |  |  |  |  |
| `demo_record` |  |  |  |  |  |  |  |
| `file_view` | + | + |  |  |  |  |  |
| `fs_append` |  |  | + |  |  |  |  |
| `fs_delete` | + | + | + |  |  |  |  |
| `fs_edit` | + |  |  |  |  |  |  |
| `fs_list` |  |  | + |  |  |  |  |
| `fs_mkdir` | + |  |  |  |  |  |  |
| `fs_move` | + |  |  |  |  |  |  |
| `fs_read` | + | + |  |  |  |  |  |
| `fs_search` | + |  |  |  |  |  |  |
| `fs_write` | + | + | + |  |  |  |  |
| `input_batch` | + | + |  |  |  |  |  |
| `input_click` | + | + |  |  |  |  |  |
| `input_key` | + | + |  |  |  |  |  |
| `input_mouse` | + |  |  |  |  |  |  |
| `input_type` | + | + |  |  |  |  |  |
| `job_status` | + |  |  |  |  |  |  |
| `knowledge_consult` | + |  |  |  |  |  |  |
| `list_reminders` |  |  | + |  |  |  |  |
| `look` | + | + | + |  |  |  |  |
| `mail_read` | + |  |  |  |  |  |  |
| `mail_send` | + |  |  |  |  |  |  |
| `market_analyze` | + |  |  |  |  |  |  |
| `market_backtest` |  |  |  |  |  |  |  |
| `market_candles` |  |  |  |  |  |  |  |
| `market_news` |  |  |  |  |  |  |  |
| `market_quote` | + |  |  |  |  |  |  |
| `memory_forget` |  | + |  |  |  |  |  |
| `memory_search` |  |  | + |  |  |  |  |
| `memory_write` | + | + |  |  |  |  |  |
| `message_send` | + | + |  |  |  | + | message.send - отправка vk/telegram userbot (гарды §14 на сервере) |
| `monitor_assign` |  |  |  |  |  |  |  |
| `monitor_list` |  |  |  |  |  |  |  |
| `monitor_set` |  |  |  |  |  |  |  |
| `obligation_add` |  |  |  |  |  |  |  |
| `obligation_list` |  |  |  |  |  |  |  |
| `obligation_remove` |  |  |  |  |  |  |  |
| `obs_request` | + |  |  |  |  | + | Запрос obs-websocket v5 |
| `office_excel` | + |  |  |  |  | + | Excel через COM: read/write_cell/append_row |
| `office_word` | + |  |  |  |  | + | Word через COM: read/write/append |
| `order_place` | + |  |  |  |  | + | Заказ под spend-cap/allowlist/confirm/красная линия карты (в EXCLUDED_TOOLS; клиент M7-заглушка) |
| `screen_capture` | + | + |  |  |  |  |  |
| `screen_probe` | + |  |  |  |  |  |  |
| `screen_read_text` | + |  |  |  |  |  |  |
| `screen_selection` |  |  |  |  |  | + | Режим выделения: start/view/clear, вуаль, свежий кадр области |
| `self_code_read` |  | + |  |  |  |  |  |
| `self_code_search` |  | + |  |  |  |  |  |
| `self_patch` |  | + |  |  |  |  |  |
| `self_weaknesses` |  | + |  |  |  |  |  |
| `set_reminder` | + | + |  |  |  |  |  |
| `skill_execute` | + |  |  |  |  |  |  |
| `skill_list` | + |  |  |  |  |  |  |
| `skill_promote` | + |  |  |  |  |  |  |
| `skill_save` | + | + |  |  |  |  |  |
| `system_clipboard` | + |  | + |  |  |  |  |
| `system_layout` |  |  |  |  |  | + | Переключение раскладки foreground-окна с readback |
| `system_lock` | + |  |  |  |  | + | Блокировка рабочей станции |
| `system_media` |  |  |  |  |  | + | Медиа-клавиши, state по WASAPI peak, pause только при звуке |
| `system_power` | + |  | + |  |  | + | sleep/shutdown/restart (отложенно)/logoff/cancel |
| `system_volume` |  | + | + |  |  | + | Громкость get/set/up/down/mute через Core Audio с readback |
| `telegram_read` | + |  |  |  |  | + | Чтение последних сообщений чата Telegram web |
| `telegram_send` | + | + |  |  |  | + | Невидимая отправка в Telegram web через браузер Джарвиса с проверкой пузыря |
| `telegram_send_voice` | + |  |  |  |  | + | Голосовое в Telegram голосом филиппа (подмена микрофона в расширении) |
| `tinkoff_portfolio` | + |  |  |  |  | + | Портфель Тинькофф read-only |
| `tool_create` |  |  |  |  |  |  |  |
| `tool_list` |  |  |  |  |  |  |  |
| `tool_load` | + | + |  |  |  |  |  |
| `tool_remove` |  |  |  |  |  |  |  |
| `trade_predict` | + |  |  |  |  |  |  |
| `trade_predictions` |  |  |  |  |  |  |  |
| `trade_winrate` | + |  |  |  |  |  |  |
| `ui_ground` | + |  |  |  |  |  |  |
| `ui_invoke` | + |  |  |  |  |  |  |
| `ui_snapshot` | + | + |  |  |  |  |  |
| `wait_for` | + |  |  |  |  |  |  |
| `watch_cancel` |  |  |  |  |  |  |  |
| `watch_create` | + |  |  |  |  |  |  |
| `watch_list` |  |  |  |  |  |  |  |
| `web_act` | + | + |  |  |  |  |  |
| `web_fetch` | + | + |  |  |  |  |  |
| `web_inspect` | + | + |  |  |  |  |  |
| `web_login` | + | + |  |  |  | + | Видимое окно входа в профиль невидимого браузера (владелец входит сам) |
| `web_open` | + | + | + |  |  |  |  |
| `web_read` | + | + |  |  |  |  |  |
| `web_search` | + | + | + |  |  |  |  |
| `window` |  | + |  |  |  |  |  |
| `window_arrange` |  |  |  |  |  |  |  |
| `window_focus` |  |  | + |  |  |  |  |
| `window_list` |  | + | + |  |  |  |  |

## Виды команд клиенту (ActionCommand)

| Вид | U | I | T | S | R | L | ПК | Причина live-only |
|---|---|---|---|---|---|---|---|---|
| `app.close` | + |  |  |  |  |  | + |  |
| `app.focus` | + | + |  |  |  |  | + |  |
| `app.launch` | + | + | + |  |  |  | + |  |
| `audio.sessions` |  |  |  |  |  | + | + | Кто звучит: Core Audio сессии по процессам с пиком |
| `audio.set` |  | + |  |  |  | + | + | Точечный мьют/громкость приложения |
| `browser.open` | + | + |  |  |  |  | + |  |
| `code.run` | + | + |  |  |  |  | + |  |
| `context.read` | + |  |  |  |  |  | + |  |
| `demo.record` |  |  |  |  |  |  | + |  |
| `fs.append` |  |  | + |  |  |  | + |  |
| `fs.delete` | + | + | + |  |  |  | + |  |
| `fs.edit` |  |  |  |  |  |  | + |  |
| `fs.list` |  |  | + |  |  |  | + |  |
| `fs.mkdir` |  |  |  |  |  |  | + |  |
| `fs.move` |  |  |  |  |  |  | + |  |
| `fs.read` |  | + |  |  |  |  | + |  |
| `fs.search` | + |  |  |  |  |  | + |  |
| `fs.view` | + | + |  |  |  |  | + |  |
| `fs.write` |  | + | + |  |  |  | + |  |
| `gui.act` | + | + |  |  |  |  | + |  |
| `input.click` | + | + |  |  |  |  | + |  |
| `input.key` | + | + |  |  |  |  | + |  |
| `input.mouse` | + | + |  |  |  |  | + |  |
| `input.type` | + | + |  |  |  |  | + |  |
| `jbrowser.act` | + | + |  |  |  |  | + |  |
| `jbrowser.import_cookies` |  |  |  |  |  | + | + | Импорт кук из расширения в браузер Джарвиса |
| `jbrowser.inspect` |  | + |  |  |  |  | + |  |
| `jbrowser.login` |  |  |  |  |  | + | + | Открыть видимое окно входа в общий профиль |
| `jbrowser.open` |  |  |  |  |  |  | + |  |
| `jbrowser.read` | + | + |  |  |  |  | + |  |
| `job.status` | + |  |  |  |  |  | + |  |
| `message.send` | + |  |  |  |  | + | + | message.send - отправка vk/telegram userbot (гарды §14 на сервере) |
| `monitor.assign` |  |  |  |  |  |  | + |  |
| `monitor.list` |  |  |  |  |  |  | + |  |
| `monitor.set` |  |  |  |  |  |  | + |  |
| `obs.request` |  |  |  |  |  | + | + | Запрос obs-websocket v5 |
| `office.excel` | + |  |  |  |  | + | + | Excel через COM: read/write_cell/append_row |
| `office.word` | + |  |  |  |  | + | + | Word через COM: read/write/append |
| `order.place` | + |  |  |  |  |  | + |  |
| `screen.capture` | + | + |  |  |  |  | + |  |
| `screen.ocr` | + |  |  |  |  |  | + |  |
| `screen.probe` | + |  |  |  |  |  | + |  |
| `screen.selection` | + |  |  |  |  | + | + | Режим выделения: start/view/clear, вуаль, свежий кадр области |
| `skill.execute` | + | + |  |  |  |  | + |  |
| `system.clipboard` | + |  | + |  |  |  | + |  |
| `system.layout` | + |  |  |  |  | + | + | Переключение раскладки foreground-окна с readback |
| `system.lock` | + |  |  |  |  | + | + | Блокировка рабочей станции |
| `system.media` | + | + |  |  |  | + | + | Медиа-клавиши, state по WASAPI peak, pause только при звуке |
| `system.power` | + |  |  |  |  | + | + | sleep/shutdown/restart (отложенно)/logoff/cancel |
| `system.volume` | + | + | + |  |  | + | + | Громкость get/set/up/down/mute через Core Audio с readback |
| `telegram.read` | + | + |  |  |  | + | + | Чтение последних сообщений чата Telegram web |
| `telegram.send` | + | + |  |  |  | + | + | Невидимая отправка в Telegram web через браузер Джарвиса с проверкой пузыря |
| `ui.ground` | + |  |  |  |  |  | + |  |
| `ui.invoke` | + | + |  |  |  |  | + |  |
| `ui.snapshot` | + | + |  |  |  |  | + |  |
| `wait.for` | + |  |  |  |  |  | + |  |
| `window.arrange` | + | + |  |  |  |  | + |  |
| `window.focus` | + | + | + |  |  |  | + |  |
| `window.list` | + | + | + |  |  |  | + |  |

## Интенты tier0

| Интент | U | I | T | S | R | L | Причина live-only |
|---|---|---|---|---|---|---|---|
| `app.focus` | + |  |  |  |  |  |  |
| `app.launch` | + | + |  |  |  |  |  |
| `browser.open` | + |  |  |  |  |  |  |
| `clarify` | + |  |  |  |  |  |  |
| `media` | + |  |  |  |  |  |  |
| `selection` | + |  |  |  |  |  |  |
| `volume` | + |  |  |  |  |  |  |

## Замечания сборщика

- тесты-перечисления не засчитаны (≥20 имён): apps/client/main/actuators/act-bridge.test.ts (23), apps/client/main/actuators/dispatch-honesty.test.ts (21), apps/server/src/brain/agent/error-voice.test.ts (44), apps/server/src/brain/agent/index.test.ts (36), apps/server/src/brain/agent/selection-loop.test.ts (32), apps/server/src/brain/tasks/task.test.ts (20), apps/server/src/brain/tools/credential-w2.test.ts (21), apps/server/src/brain/tools/input-kinds.test.ts (36), packages/tools/src/facades.test.ts (21), packages/tools/src/index.test.ts (66)
