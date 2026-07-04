# Ревью кода Jarvis — 2026-06-17 (многоагентное, состязательная верификация)

> Многоагентный прогон (wf_1e07bf15-885): 11 ревьюеров по подсистемам → 60 находок →
> состязательная верификация каждой → **28 подтверждено**. Полный машинный отчёт:
> `tasks/webuiq7lp.output`. Ниже — итог + что применено в этой сессии.

## ✅ ПРИМЕНЕНО этой сессией (все тесты зелёные: 432 серв. + 71 клиент)

| # | Файл | Что | Severity |
|---|------|-----|----------|
| A | [anthropic.ts](apps/server/src/integrations/anthropic.ts) | НЕ спать backoff после последней попытки + НЕ ретраить детерминированные 4xx → стаб сразу (убирает ~1–2с лишней задержки на сбое связи) | P2 |
| B | [pipeline.ts](apps/server/src/voice/pipeline.ts) `endpointTurn` | gen-guard у async `checkSpeaker`: стейл-вердикт прошлого хода больше не финализирует НОВУЮ реплику после barge-in | P2 |
| C | [sherpa-verifier.ts](apps/server/src/voice/speaker/sherpa-verifier.ts) `identify` | косинус по min(len) маскировал смену модели → теперь отбраковка профиля чужой dim/modelId (Фаза 0) | P2 |
| D | [store.ts](apps/server/src/voice/speaker/store.ts) | атомарная запись voices.json (tmp+rename) + различать «нет файла» vs «битый» (битый → error+бэкап, не тихое отключение гейта) | P2 |
| E | [tts-cache.ts](apps/server/src/integrations/tts-cache.ts) | ключ кеша TTS теперь включает speed/stability/style — кеш больше не отдаёт чужую подачу режима | P2 |
| F | [episodic.ts](apps/server/src/memory/episodic.ts) + потребители | обвязка порога релевантности `JARVIS_MEMORY_MIN_SCORE` (анти-конфабуляция); **дефолт 0=выкл** — нужна калибровка под embedding-модель | P2 |
| G | [dispatch.ts](apps/server/src/brain/tools/dispatch.ts) `memory_search` | clamp topK к целому 1..50 (дробное/отрицательное от LLM роняло SQL LIMIT → тихий пустой результат) | P2 |
| H | [code-runner.ts](apps/client/main/actuators/code-runner.ts) | таймаут убивает ВСЁ дерево процессов (taskkill /T /F) — внуки больше не утекают; rm temp с ретраями+логом | P2/P3 |
| I | [system.ts](apps/client/main/actuators/system.ts) `exec` | таймаут снимается (clearTimeout) + убивает зависший powershell (был осиротевший процесс) | P3 |
| J | [deepgram.ts](apps/server/src/integrations/deepgram.ts) `pushAudio` | кольцевой буфер кадров (кэп ~5с) — нет неогранич. роста памяти на зависшем WS | P3 |

> Примечание: пункт C закрывает и отдельную находку «cosine по min(len)» — реализовано в рамках
> Фазы 0 идентификации голоса (см. NEXT_SESSION).

## 🟡 ПОДТВЕРЖДЕНО, НО ОТЛОЖЕНО (нужен бóльший рефактор / риск регресса)

### Кластер reconnect/resume сессии (P1+P2) — связаны, чинить вместе
- **P1 [server.ts:315-329]** — `close` старого сокета после resume зовёт `registry.remove` вслепую →
  уничтожает ЖИВУЮ переподключённую сессию (та же `Session` через `rebind`). Для M0 resume не
  доведён («снимаем сразу»), баг латентный, но при доводке resume выстрелит.
- **P2 [server.ts:371-373]** — двойной heartbeat на сессии при перекрывающемся resume (утечка
  таймера + ложный разрыв через тот же `registry.remove`).
- **P2 [client transport flushOutbox]** — шлёт `action.result` сразу на `open`, до подтверждения
  resume → при resumed=false результаты теряются (нарушение at-least-once §5).
- **Фикс кластера:** хранить identity сокета/поколение в `Session`; `registry.remove` только если
  сессия всё ещё привязана к закрывшемуся сокету; `flushOutbox` после `server.hello{resumed:true}`;
  глушить старый heartbeat в `rebind`. Делать ВМЕСТЕ с реальной реализацией resume.

### Связь (диагноз — главная боль пользователя)
- **Deepgram reconnect-in-stream** (nextSession P1 `no-network-reconnect-in-stream`): WS не
  переподключается при обрыве посреди стрима; `committed` теряется. **План:** вынести создание WS
  в `connect()`, на неожиданный `close` (не наш) с транзиентным кодом и в пределах retry-бюджета —
  reconnect с backoff, сохраняя `committed`; подавлять error-спам во время реконнекта. Тест — через
  инъекцию mock-WS (конструктор уже принимает `WsCtor`). Риск: трогает рабочий путь STT — делать
  с живым микрофоном.
- **Persistent Deepgram WS на разговор** (P1 `deepgram-reopen-per-turn`): сейчас WS переоткрывается
  КАЖДЫЙ ход (churn + латентность + каждый хендшейк = шанс сбоя). Держать один WS на окно разговора.
- **Client connect-watchdog** [transport/index.ts]: нет таймаута на фазу WS-хендшейка → полуоткрытый
  TCP не уходит в reconnect. Добавить `connectTimeout`→`ws.terminate()` (он сам даст close→reconnect).

### Прочее P2 (fix_safe=false — риск, нужна осторожность)
- **Отмена теряется для задач в очереди семафора** [agent/index.ts]: «отмени» не видит задачу, ещё
  стоящую в `waiters` (Task создаётся ПОСЛЕ `sem.acquire`). Фикс: регистрировать Task до acquire /
  проверять cancel после acquire. Нужно при ≥6 параллельных фоновых задачах.
- **TOCTOU идемпотентности outbound** [outbound.ts]: два параллельных одинаковых `send` → дубль
  адресату. Фикс: резервировать ключ ДО отправки / per-key замок.
- **Гонка `dispatch` не awaited** [server.ts:308] + **двойная финализация enroll** [router-ws.ts:337]
  + **гонка persist voices.json**: сериализовать обработку ws-сообщений на сессию / мьютекс в сторе.
- **Авто-reconnect сайдкара** [sidecar-client.ts]: после краха `ready=false` навсегда. Backoff-респаун.
- **consolidation guard** [consolidation/index.ts]: `applySkillRevision` не блокирует guard-шаги в
  `proposed` → автоправка может ВНЕДРИТЬ необратимое действие. Латентно до M4, но контракт §8 нарушен.

### P3 (мелочи устойчивости/гигиены)
- silenceTimer не сбрасывается на speech_start/barge_in (косметический churn таймеров).
- deepgram: синхронная ошибка конструктора WS глотается (errorCb ещё не навешан) — почти мёртвый путь.
- completeStream: частичный сбой стрима → usage=0 (недоучёт расхода SpendGuard).
- presence `userAwayFromDesktop` смотрит только первый десктоп (мёртвый код до провода §20).
- store.add: при сбое persist рапортует ok=true (после рестарта голос пропадёт).

## #D из диагноза (НЕ из ревью) — wake-gate дропнул фрустрированную команду
«Ну так сделай, jarrefs…» отброшено как «без обращения». В активном окне разговора команда должна
приниматься БЕЗ wake-слова — значит окно (`awake`/`lastActiveAt`/`convWindowMs`) к тому моменту
закрылось (вероятно за время стаб-задержек) ИЛИ `awake` сбросился. Гейт уже многократно чинился
(«слушает 5-10с и глохнет») — НЕ трогал вслепую. **Надо:** прицельный лог `awake/lastActiveAt/
convWindowMs` в ветке дропа, поймать на живом разговоре, потом точечный фикс.
