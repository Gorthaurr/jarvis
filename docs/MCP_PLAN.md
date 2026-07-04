# MCP-арсенал для Джарвиса — план внедрения (из воркфлоу 2026-06-19, сверено с кодом)

Цель: дать Джарвису инструменты уровня Claude Code — подключение ЛЮБОГО MCP-сервера (файлы, git,
github, fetch, Playwright, Postgres и т.д.) + улучшенная консоль, БЕЗ раздувания контекста/латентности.

## Главный вывод (блокеры, которые НЕЛЬЗЯ откладывать)
`tools[]` собирается на КАЖДОМ шаге петли (`agent/index.ts:495-498`) и уходит в Anthropic **в префиксе
ПЕРЕД `system`, БЕЗ `cache_control`**. Любая мутация `tools[]` между ходами → инвалидирует ВЕСЬ
prompt-кеш (персона+навык+диалог, §15). Поэтому MCP нельзя внедрять без **ленивой загрузки**, иначе
регресс латентности (уже была до 51с) и денег.

## Порядок внедрения (эффект/риск)
### Шаг 1 — ЛЕНИВАЯ ЗАГРУЗКА (пререквизит + сам по себе чинит «медленно»)
Двухслойный реестр + 2 мета-tool (как ToolSearch у Claude Code):
- **HOT (~25-30, всегда в `tools[]`, отсортированы детерминированно → байт-стабильный префикс):**
  web_search/fetch, memory_search/write, browser_open/read/act, screen_capture, code_run,
  fs_read/write/edit, app_launch/focus/close, system_*, set_reminder, skill_list/execute,
  + мета `tool_search`, `tool_load`.
- **COLD (только однострочники в кешируемом каталоге, НЕ в `tools[]`):** все `mcp__*`, редкие нативные
  (office_*, obs_request, monitor_*, order_place, telegram_*, web_open/act/login, tool_create/remove),
  все dynamicTools. ~150 tools × ~12 ток ≈ 1.8К вместо ~156К → −98% префикса.
- Каталог COLD → НОВЫЙ кешируемый системный блок `systemTools` (4-й cache breakpoint:
  персона+каталог+навык+rolling = ровно 4, без запаса). `anthropic.ts buildSystemBlocks` (~300-308).
- `tool_load({names})` кладёт имена в per-session `ToolActivationSet` (новое поле в AgentDeps/ToolContext,
  как dynamicTools); раскрытые схемы дописываются В ХВОСТ `tools[]` (инвалидирует кеш только с хвоста —
  разовая плата, как rolling-breakpoint `agent/index.ts:1056`). НЕ в середину.
- Опц. ускоритель: `classifyTier`/router предзагружает набор под тип задачи до 1-го хода.
- Правки: packages/tools (HOT_TOOL_NAMES + toolCatalogLine + META_TOOLS схемы tool_search/load),
  agent/index.ts:495 (hot+активный набор, systemTools=каталог), llm.ts (поле systemTools),
  anthropic.ts (4-й блок), dispatch.ts (ветки tool_search/tool_load server-side).
- ⚠️ Проверить токен-каунтером: мин. кешируемый префикс Opus = 4096 ток (каталог ~1.8К сам не закешится,
  если до его брейкпоинта < 4096 — но персона+каталог суммарно перешагнут).

### Шаг 2 — McpManager (клон DynamicToolStore)
- Новые: `brain/mcp/manager.ts`, `brain/mcp/config.ts` (mcp.json, `${ENV}`-резолв, Windows `npx→npx.cmd`),
  `brain/mcp/catalog.ts`; `jarvis/mcp.json` (секреты только `${ENV}`, в .gitignore).
- `@modelcontextprotocol/sdk` (ESM). Транспорты: `StdioClientTransport` (локальные npx),
  `StreamableHTTPClientTransport`/`SSE` (удалённые). `Promise.allSettled` — сбой сервера не валит остальные.
- Namespacing `mcp__<server>__<tool>`, санитайз к `[a-zA-Z0-9_-]{1,64}` + обратный маппинг (иначе 400).
- inputSchema MCP→Anthropic: защитный нормализатор (нет type→"object", нет properties→{}).
- boot `server.ts`: создать рядом с DynamicToolStore (~144), `connectAll()` **fire-and-forget, НЕ await
  перед app.listen (252)**; в BrainProviders (155-163); `mcp.status()` в /healthz (221); dispose (257).
- dispatch.ts: **строго рядом со строкой 174** (после KIND_BY_TOOL и confirm-гейтов):
  `if (!KIND_BY_TOOL[name] && ctx.mcp?.has(name)) return ctx.mcp.callTool(name, input);`
  → MCP-tool НИКОГДА не затеняет confirm-гейтнутые fs_delete/system_power.
- Результат MCP (content[] text/image + isError) конвертить как lookAtScreen (163-164); ошибка → err(), не throw.

### Шаг 3 — сервера + консоль + безопасность
- Бандл-минимум (npx, Windows): filesystem (но у нас fs_* уже есть), **git, github, fetch, playwright,
  postgres/sqlite, sequential-thinking, time**. Добавление сервера = строка в mcp.json.
- Консоль: code_run (powershell/node/python) есть; не хватает персистентной рабочей папки + стрима +
  длинных процессов — улучшить code_run или отдельный shell-MCP.
- БЕЗОПАСНОСТЬ: MCP-сервер из npx = чужой код с правами юзера (supply-chain!). → **allowlist серверов в
  mcp.json**, confirm-гейт (§14) на разрушительные MCP-tools (по эвристике имени delete/write/push/send),
  красные линии §0 (платежи) поверх. Как у Claude Code permissions, но строже по умолчанию.

## Состязательные предупреждения (учтены выше)
- Не класть MCP-схемы в `tools[]` напрямую — убьёт кеш §15.
- connectAll НЕ блокирует app.listen — иначе зависший stdio-сервер не даст серверу подняться.
- killTree (taskkill /T /F) для stdio-child на Windows — иначе зомби-процессы.
- tabId/таргетинг и честность по ошибкам — наследовать существующие инварианты.

Полный синтез воркфлоу: task `wzmmg5qvw` (+ браузер-глаза: `wy2i3i1x0`).
