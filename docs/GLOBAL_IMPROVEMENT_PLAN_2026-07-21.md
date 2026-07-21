# Джарвис: глобальный план улучшения со всех углов + вердикт по «MCP для всего» (2026-07-21)

> Заказ владельца: ресёрч концептов (голосовые/компьютер-контроль LLM-агенты, как LLM работают с голосом
> и приложениями), решение идти подходом **«MCP для всего»**, ревью веб-серчинга — всё в ОДИН глобальный
> план полного улучшения со всех углов.
>
> Метод: 9-агентный workflow — голос, app-control, MCP-экосистема (+реестр), web-search, аналоги Джарвиса,
> GitHub/MCP-серверы, картирование tool-архитектуры, картирование голос/поиск → синтез.
> Память/контекст — отдельный ресёрч: **docs/ENV_QUALITY_RESEARCH_2026-07-21.md** (интегрирован ссылкой).

## Главный вывод

**Джарвис уже — референс-реализация того, к чему пришёл фронтир 2025-2026** (accessibility-first гибрид +
закон честности fused-observe = «независимый верификатор» из academia). Улучшать нужно **не архитектуру, а
грундинг / латентность / качество извлечения**, а «MCP для всего» строить **ФАЗНО как расширение API-плеча,
не замену законам**.

## Вердикт по «MCP для всего»: ГИБРИД, не полный MCP — и это ЧЕСТНО уважает твоё решение

«MCP для всего» жизнеспособно **только в той форме, которую Джарвис уже частично построил**. Ключевой факт:
Джарвис **независимо** реализовал ОБЕ санкционированные индустрией MCP-интервенции — §15 COLD/`tool_load` =
Anthropic Tool Search (−85% токенов), jarvis SDK через `code_run` = Anthropic «code execution with MCP»
(150K→2K токенов) — причём **БЕЗ MCP-хопа**.

**Что идёт в MCP (Фаза A, низкий риск, делать сейчас):** весь read-only/remote server-side класс — web-search
(Tavily/Exa), fetch, git, time, postgres, github, OBS. Все COLD (§15), stateless, без honesty/lease-связки.

**Что остаётся нативным (навсегда):**
1. **Живой аудио-контур** (STT/TTS/VAD/endpointing/barge) — MCP это JSON-RPC request/response, не PCM-стрим по
   20мс кадрам; обёртка в MCP сломала бы TTFB и barge-cancel-бюджет.
2. **Горячие Windows-актуаторы** (input/ui/window/screen/app/system/fs/office) — там живут **ТРИ закона, которых
   у стандартного MCP НЕТ**: (a) **fused-observe** (Windows-MCP делает Click и Snapshot ДВУМЯ вызовами — ровно
   паттерн, что Джарвис схлопнул ради −35-50% раундов); (b) **аренда ввода §20** (у MCP нет координации курсора
   → гонка «двух писателей»); (c) **§14 confirm/SSRF** (MCP-ветка сейчас минует блок).

**Почему не буквальный полный MCP:** латентность (+до 50ms/хоп, +10-15% под нагрузкой — прямой проигрыш голосу);
tool-poisoning через ОПИСАНИЯ tools (MCPTox ASR>60%, 200K уязвимых инстансов, инцидент Supabase); context-bloat
(7 серверов = 33.7% окна).

**Фазная миграция:**
- **A** — read/remote класс в MCP (сейчас).
- **B** — расширить MCP-result-контракт: `untrusted`+confirm+SSRF+image+декларативный `toolEffect` до возврата.
- **C** (опц., догфудинг) — ОДИН локальный stdio-MCP поверх `act-bridge` со встроенными fused-observe + арендой
  + per-session-инжектом (McpManager глобален, актуаторы per-session — нужен sessionId в `_meta`).
- **D** — чужие GUI-MCP только за флагом как fallback, никогда на горячем пути.

**MINE-DON'T-ADOPT:** внешние desktop-MCP (Windows-MCP 6.5k⭐, desktop-touch-mcp) — desktop-touch-mcp
**независимо переизобрёл ровно lease/perception-guard Джарвиса** (валидирует дизайн), но раздельный act/observe
регрессирует честность → не отдавать им GUI-путь.

## Столпы (currentState → targetMoves)

**1. Голос (STT→Claude→TTS каскад)** — каскад ВЫНУЖДЕННО и ВЕРНО (у Claude нет аудио-I/O, честность держится
на текстовом ходе; валидировано Pipecat/Daily/Coval). Гэпы: turn-detector = стоп-словная заглушка; loopback-AEC
нет; wake = текстовый Mock. → smart-turn-v3 (русский, CPU, 85% TPR, до trailing silence); loopback-AEC; filler-
логика + выравнивание порогов VAD; openWakeWord; опц. v3-стрим TTS дефолтом.

**2. App-control** — гибрид UIA-сайдкар + DOM-расширение + screen/OCR + code_run + API-актуаторы + fused-observe
= ровно лучший признанный гибрид (Navi/WAA/UFO2); мозг Opus 4.8 на фронтире (61-78% OSWorld). Узкое место — НЕ
интеллект, а **грундинг UIA-слепых окон**. → локальный SoM-грундер (OmniParser-v2/UI-TARS) сайдкаром для
canvas/игр; пре-даунскейл скринов + калибровка координат (высший ROI по клик-точности); правило «текст перед
изображением».

**3. MCP tool-layer** — см. вердикт выше. → Фаза A/B/C, динамический embedding tool-retrieval + tool-result-digest.

**4. Web-search** — Brave→DDG keyless + web_fetch = голый fetch + ГРУБЫЙ regex-strip (nav/footer-шум в LLM). →
Readability/Jina Reader вместо strip (самый дешёвый крупный выигрыш); freshness=pd/pw; Tavily/Exa MCP как COLD
research (Brave остаётся quick-путём); broad-to-narrow + параллельная декомпозиция; tool-effectiveness в metrics.

**5. Память/контекст** — детальный план в **docs/ENV_QUALITY_RESEARCH_2026-07-21.md**. Доп: из Agent S2 —
нарративный слой верифицированной траектории + дистилляция навыка с 1 успеха; реранкер против потолка e5-small.

**6. Дилидженс/прогресс (честность+наблюдаемость)** — fused-observe + verify-loop НАУЧНО валидирован
(arxiv 2604.06240 «независимый верификатор»; таксономия tool-use-hallucination). Джарвис реализовал СТРУКТУРНО,
не промптом — **главное дифференцирующее преимущество, НЕ разменивать при MCP-миграции**. → расширить error-voice
таксономией; наблюдаемость скрытых деградаций web/MCP (пустой search=[], MCP-provoked verify-долг) в metrics.

## Глобальный роадмап

### P0
- **web_fetch: Readability вместо regex-strip** — `@mozilla/readability`+jsdom (84%) / Jina Reader keyless (81%).
  Файлы: `integrations/web.ts` (extractReadable, parseDuckDuckGoLite, кап), `handlers/info.ts`.
- **Расширить MCP-result-контракт** — untrusted+confirm+SSRF+image+toolEffect ДО возврата (сейчас MCP минует §14/SSRF, теряет image). Файлы: `dispatch.ts:308-317`, `mcp/manager.ts:192-211`, `mcp.json`. **Предусловие любой MCP-миграции.**
- **Активировать read-only/remote MCP (Фаза A)** — OBS/Tavily/Exa/Fetch/Git/Time из `_disabled`→`servers`, COLD, uvx-прогрев. Файлы: `mcp.json`, `mcp/manager.ts`, ретайр `actuators/obs.ts`.
- **Локальный SoM-грундер для UIA-слепых окон** — OmniParser-v2/UI-TARS сайдкаром (canvas/WebGL/игры). Файлы: `apps/sidecar-win/` или новый node-сайдкар, `actuators/screen.ts`, `sensors-cheap.ts`.

### P1
- **smart-turn-v3 семантический конец реплики** (voice). Файлы: `voice/turn.ts:47-74`, `voice/pipeline.ts`, `deepgram.ts`, `client/vad/`.
- **Пре-даунскейл скринов + калибровка display-пространства** (app-control). Файлы: `actuators/screen.ts`, `dispatch.ts:560-570`, `sensors-cheap.ts`.
- **Семантический tool-retrieval + tool-result-digest поверх §15** (условие жизнеспособности «MCP для всего»). Файлы: `packages/tools`, `agent/index.ts:1140-1155`, `dispatch.ts` toolLoad.
- **Research-эвристики + параллельная декомпозиция web-поиска** (web-search). Файлы: `persona.md`, `agent/index.ts`, `metrics.jsonl`.
- **loopback/system-audio AEC** (эхо «слышит сам себя»). Файлы: `client/audio/index.ts`, новый ворклет.

### P2
- **Локальный actuator-MCP-фасад поверх act-bridge (Фаза C, догфудинг)** — ОДИН stdio-MCP со встроенными законами + per-session-инжект. Файлы: `act-bridge.ts`, `mcp/manager.ts`, `input-kinds.ts`.
- **Нарративная память + дистилляция с 1 показа** (Agent S2). Файлы: `memory/skills.ts`, `proactive/consolidation.ts`.
- **Гибридная S2S-ветка только для разговорных ходов** (эмоция; Yandex filipp=strict). Файлы: `router/index.ts`, `voice/pipeline.ts`.
- **Акустический wake-word (openWakeWord)** вместо текстового Mock. Файлы: `client/wakeword/`.

## Ключевые риски
1. **Tool-poisoning «MCP для всего»** через описания сторонних tools (MCPTox ASR>60%). Митигация: привилегированное — только первопартийное; сторонние — read-only/COLD/allowlist/пиннинг (H16), никогда за §14-гейтом.
2. **fused-observe несовместим со стандартным MCP tool→result** — внешний GUI/web-MCP не вернёт наблюдение → verify-долг (лишний раунд) ИЛИ ложный успех по «ok».
3. **Латентность голоса** — MCP-хоп на каждый микрошаг (click→observe) регрессирует 350-400ms endpointing / ~160ms earcon бюджет.
4. **Аренда ввода §20 не имеет MCP-аналога** — ≥2 MCP-источника GUI = гонка за курсор; `toolNeedsInput()` возвращает false для всех `mcp__*`.
5. **Структурный разрыв адресации** — McpManager глобален, актуаторы per-session; локальный actuator-MCP не знает, какому ПК слать без session-инжекта в `_meta`.
6. **Платформенное вытеснение** — MS Windows Agentic OS (Copilot Actions + нативный MCP, Ignite 2025). Преимущество Джарвиса — single-user персонализация/голос/память/честность; если MS откроет File Explorer/Settings как MCP — потреблять (Джарвис уже host).
7. **e5-small — потолок recall** у power-user (реранкер/гибрид — открытый путь).
8. **Незакоммиченные правки в дереве** — новые фичи класть поверх стабильной базы после ревью/коммита.

## Решения за владельцем
1. **Гибридная S2S-ветка** для эмоции — делать ли, на каком вендоре (gpt-realtime / Gemini native-audio / Nova Sonic)? Против провайдер-агностичности; закрывает Yandex filipp=strict.
2. **Миграция default-тира на Claude Sonnet 5** («самый агентный, сам проверяет вывод») — оценить на живом прогоне.
3. **Фаза C (локальный actuator-MCP)** — чистый догфудинг ценой +хопа; jarvis SDK уже эффективнее для GUI. Делать только если важен единый MCP-каталог.
4. **Web-search провайдер для research**: встроенный Claude web_search ($10/1k, цитаты) vs Tavily/Exa/Linkup MCP (провайдер-агностично)? Quick-путь = Brave in-process в любом случае.
5. **OmniParser-v2 vs UI-TARS** как SoM-грундер — за флагом или дефолт-резерв? («SoM = когнитивный шум» → резерв, не поверх UIA).
6. **JARVIS_BROWSER_REF** (AX-Ref) — дефолт-включение? Нужен живой смоук в Chrome + регресс-гейт на Я.Музыке.
7. **loopback-AEC** приоритет — требует живого микрофона + выбора DSP-стека (WebRTC APM / WASM).
8. **Speaker-gate** (sherpa готов, `JARVIS_SPEAKER_GATE=0`) — включать для строгого wake в шуме? Требует калибровки у микрофона.
