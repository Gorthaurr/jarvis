# Следующая сессия — хендофф

> Состояние на конец сессии 2026-06-16. Ветка `feat/native-pg-pgvector-cache-gateway`, всё
> **закоммичено** (рабочее дерево чистое). 316 серверных тестов зелёные, `pnpm -r typecheck` чист.
> Архитектура и грабли — в памяти (грузятся автоматически): `project_jarvis_architecture.md`
> (читать ПЕРВЫМ), `project_jarvis_hermes.md`, `project_jarvis_voice.md`, `feedback_universal.md`,
> `project_jarvis_handoff.md`, `project_jarvis_infra.md`.

## ГЛАВНАЯ ЗАДАЧА: realtime-голос (как Grok Voice / ChatGPT Advanced Voice)

Пользователь хочет 3 фишки «общения» как у Grok. **Две сделаны** (см. ниже), осталась
**realtime-голос** — самая большая и рискованная (трогает рабочий голосовой контур). НЕ делать
наспех: это связанный рефактор ОБЕИХ сторон, проверяется ТОЛЬКО на слух (пользователь слушает).

**Почему сейчас задержка:** все тиры на **Opus 4.8** (жёсткое требование пользователя, см. .env) —
даже болтовня медленная. ElevenLabs (HTTP `multilingual_v2`) отдаёт весь mp3 одним ответом. Клиент
(`apps/client/renderer/audio.ts` `AudioPlayback`) **копит чанки и играет ТОЛЬКО по `last`** — то
есть без изменений клиента стриминг ничего не ускорит. Реальный «вау» даёт только token-streaming.

**ПЛАН (3 части, делать по очереди, на каждой давать пользователю послушать):**
1. **LLM token-streaming.** Добавить `completeStream(req, onDelta)` в `ILlmProvider`
   (`apps/server/src/integrations/llm.ts`) + реализации: `anthropic.ts` (SDK `client.messages.stream`),
   `MockLlmProvider`. Только для КОНВЕРСАЦИОННОГО финального текста (без tool_use). Если в стриме
   пошёл `tool_use` — откатываемся на штатный мульти-шаг `runAgentLoop` (стримленный префикс обычно
   пустой на tool-ходах).
2. **Пофразный синтез + чанкер.** Утилита-аккумулятор: из дельт собирает ПРЕДЛОЖЕНИЯ (по `.!?…`/
   переносам), отдаёт по мере готовности. Каждое предложение → `tts.synthesize` сразу. ElevenLabs
   на короткой фразе отвечает быстрее → первый звук = синтез ПЕРВОГО предложения, остальное
   синтезируется во время проигрывания.
3. **Очередь воспроизведения на клиенте.** `AudioPlayback`: на каждый `last:true` — НЕ останавливать
   предыдущее (сейчас `flush()` зовёт `stop()`!), а класть utterance в ОЧЕРЕДЬ и играть по
   `onended` подряд. Barge-in/`stop()` чистит очередь + глушит текущее.

**Где вшивать (риск):** шов `onUserTurn` в `voice/pipeline.ts` → `runAgent`. Сейчас он ждёт
ПОЛНЫЙ `AgentReply` и зовёт `startTts(reply.voice)`. Для стрима нужен путь, где `onUserTurn`
отдаёт предложения по мере генерации. Беречь: `gen`-инвалидацию (barge-in), `drive`-флаг
(проактивный `speak` НЕ трогает машину состояний — см. фикс этой сессии!), `speak_start/done`,
`maybeDrainSpeech`. Низкорисковый минимум: для реплик в 1 предложение оставить текущий путь
(0 регрессий на частом кейсе), пофразный — только для многопредложенных.

**Альтернатива поменьше (если ок жить с задержкой Opus):** только п.2+п.3 (пофразный синтез +
клиентская очередь) — меньше риска, но эффект скромнее (Opus всё равно «думает» перед первым звуком).

## СДЕЛАНО этой сессией

### 1. Петля HERMES — самообучение навыками-процедурами (§8) — `a61f134`
Джарвис сам сохраняет успешный многошаговый приём навыком-процедурой (`skill_save`) и СЛЕДУЕТ ему
в похожих задачах (recall в системный промпт), НЕ реплей кликов. Детали/что-где/почему/отложено —
в памяти `project_jarvis_hermes.md`. Узлы: `memory/skills.ts` (save/recall/matchLearnedSkill,
`learned__`-префикс id, in-memory фолбэк без БД), `brain/agent/index.ts` (recall + бэкстоп
`selfLearnSkill`), `persona/index.ts` (`learnedSkill`-слот), `dispatch.ts` (`skillSave`),
`gateway/router-ws.ts` `pushSavedSkills` (фильтр learned). Пост-ревью хардненг (9 находок) внутри
коммита. ОТЛОЖЕНО (HERMES): улучшение навыка на ОШИБКЕ recall'нутого; куратор stale/archive;
семантический recall (эмбеддинги when/name); клиентский confirm на UI-повтор guard-навыка
(`runSavedSkill` в client — ПРЕД-сущ. дыра §14, заведена задача-чип).

### 2. Голос: два фикса «не слышит» / «перестал слушать» — `61ed8c0`, `16c9846`
- **«спросил и перестал слушать»:** фоновый итог (§20) произносился из idle/listening, машина НЕ
  входила в speaking → не срабатывал возврат `speak_done → listening + follow-up`. Фикс: `speak_start`
  переводит в speaking и из idle/listening (`voice/state.ts`).
- **регрессия «не слышит»:** тот фикс заставлял и онбординг-приветствие гнать в speaking →
  churn STT на старте. Фикс: проактивный `speak()` — fire-and-forget (`drive=false`), НЕ трогает
  цикл (`voice/pipeline.ts`). ВАЖНО беречь это при realtime-рефакторе.

### 3. Невидимый браузер ОЖИЛ — WebSocket из пакета `ws` — `194ed5a`
Корень «не может невидимо как в TG, жалуется на отсутствие инструмента»: оба CDP-клиента
(`jarvis-browser.ts` невидимый + `browser-cdp.ts` видимый) брали `globalThis.WebSocket`, которого
**в main-процессе Electron 33 (Node 20.x) НЕТ** → `web_open/web_act/web_read` падали. Фикс: берём
`WebSocket` из пакета `ws` (как транспорт). Проверено по логу: `web_open/act/read isError:false`.
Это фундамент универсальности — общие руки на любом залогиненном сервисе.

### 4. `web_login` — вход в сервис видимо, дальше невидимо — `ee98d81`
Не залогинен → Джарвис открывает страницу входа ВИДИМО (тот же профиль), юзер входит один раз,
дальше работает невидимо. Tool `web_login(url)` → `jbrowser.login` → `jarvisBrowser().openLogin(url)`.
Персона §8 учит распознавать стену логина. Любой сервис (ВК и т.д.) становится залогиненным как TG.

### 5. UI — полное соответствие макету «Премиум-минимал» — `8ba2fa5`, `8ceb757`, `b389101`, `df43f7f`
Исходник — `Дизайн электрона.zip` (`port/Jarvis Redesign - standalone.html` + `.dc.html` + `styles.css`).
Перенёс 1:1: near-black слои, циан `#5ed6ff`, **живой CSS-эквалайзер** (`@keyframes eq`, 26 столбиков,
огибающая sin — параметры из макета, всегда «живые», НЕ от микрофона), **кольцо только в «Думаю»**,
вкладки настроек (Общее/Навыки/Ключи/Оплата), шестерёнка-cog, шрифт Manrope (`@fontsource-variable/manrope`).
Проверял рендером через preview-сервер (скриншот зависал на анимациях → паузил `animationPlayState`
перед захватом; превью-сервер отдавал SOURCE renderer, не dist). ОТЛОЖЕНО: «Deep Focus·50:00» —
это пример-контент макета (нет механизма), не добавлял.

### 6. Личности/голоса — режимы-маски Джарвиса (§11) — `c4890df`
Переключаемый ТОН одного Джарвиса (не другой персонаж): дворецкий(база)/дерзкий/рассказчик/с юмором.
Голосом «будь дерзким»/«будь собой» (детерминированно, `matchModeCommand` на подстроках — `\b`/`\w`
в JS НЕ работают с кириллицей!). Меняет формулировку (оверлей к персоне) + подачу голоса ElevenLabs
(`voice_settings` style/stability/speed на том же голосе). `profile.mode` персистит. Узлы:
`persona/modes.ts`, `persona/index.ts` (`personaTone`), `agent/index.ts`, `voice-providers.ts`+`elevenlabs.ts`
(per-call settings), `pipeline.ts` (`getVoiceOpts`), `router-ws.ts`. ОТЛОЖЕНО: вкладка «Характер» в
настройках (UI-переключатель режимов); разные voiceId (у юзера один голос — сейчас отличие через voice_settings).

### 7. Проактивность/память — контекстное приветствие (§9/§11) — `91187c8`
Джарвис открывает сессию КОНТЕКСТНО: время суток + что помнит (имя, факты, недавняя episodic-память)
→ живой опенер, при уместности с проактивным вопросом. Best-effort (haiku, под таймаутом) с фолбэком.
`proactive/greeting.ts` (`timeOfDay`+`buildGreeting`, профиль инъектится — без глоб. состояния).
ОТЛОЖЕНО (бо́льшая проактивность): триггеры (`proactive/triggers/index.ts`) — ВСЁ ещё СТУБЫ (TODO M5):
сам заводит разговор СРЕДИ сессии по времени/событиям. Инфра готова (salience/presence/NudgeQueue/
scheduler), нет источников триггеров + хранилища напоминаний.

## Как запускать (durable) / проверять
- **Сервер:** убить владельца 8787 → `Start-Process cmd.exe '/c', 'cd /d "<repo>\apps\server" && node "<repo>\node_modules\tsx\dist\cli.mjs" src/index.ts > "<repo>\server.log" 2>&1' -WindowStyle Hidden`. PowerShell-вызов СРАЗУ выходит. Ждать `healthz` (порт 8787).
- **Клиент:** пересборка `pnpm --filter @jarvis/client build`; запуск `Start-Process <repo>\node_modules\.pnpm\electron@33.4.11\node_modules\electron\dist\electron.exe "." -WorkingDirectory apps\client`. Для диагностики можно `-RedirectStandardOutput client.out.log -RedirectStandardError client.err.log` (рендерер-логи и ошибки актуаторов видны там).
- **Проверки:** `pnpm -r typecheck`; `pnpm --filter @jarvis/server test` (316); `@jarvis/tools test`; `@jarvis/client test`.
- **server.log ТОЛЬКО в UTF-8** (`Get-Content -Encoding UTF8`! иначе кракозябры и ложные «0 хендшейков»). 1 handshake / 1 сессия, без реконнект-флаппинга.
- **БД:** локально нативный Postgres (`postgres://postgres:...@localhost:5432/jarvis`) — `db: 'configured'`. HERMES-навыки/эпизоды durable.

## Чего НЕ делать (грабли)
- realtime-голос — НЕ вшивать наспех в `pipeline.ts`/`runAgentLoop` без проверки на слух; беречь
  `drive=false` для проактивного `speak` (иначе вернётся «не слышит»), `gen`-инвалидацию, barge-in.
- В JS-регексах с кириллицей НЕ использовать `\b`/`\w` — не работают; матчить подстроками/`[а-яё]`.
- НЕ хардкодить под сервис — общие руки (`web_open/act/login`) + навыки + LLM решает.
- НЕ читать `server.log` без `-Encoding UTF8`. НЕ частить рестартами (флаппинг).
- НЕ менять модель/тиры с Opus (требование) и TTS с `multilingual_v2` (точность > скорости, выбор юзера).
- preview-скриншот зависает на работающих CSS-анимациях → перед захватом
  `document.querySelectorAll('*').forEach(e=>e.style.animationPlayState='paused')`.

## Открытые задачи (приоритет сверху)
1. **realtime-голос** (главная, см. выше).
2. Бо́льшая проактивность: реальные триггеры (время/события) среди сессии + хранилище напоминаний.
3. Вкладка «Характер» в настройках (UI-переключатель режимов §11).
4. Клиентский confirm на UI-повтор guard-навыка (§14, пред-сущ. дыра, есть задача-чип).
5. HERMES-куратор: улучшение навыка на ошибке, stale/archive, семантический recall.
