# Окружение → качество агента: ресёрч + GitHub + карта по Джарвису (2026-07-21)

> Заказ владельца: копнуть ГЛУБЖЕ и ШИРЕ, как ОКРУЖЕНИЕ/КОНТЕКСТ бьёт по качеству агента
> (тема «AI Agents Do Not Fail Alone: The Context Fails First»), по САМЫМ СВЕЖИМ источникам (2025-2026),
> проверить GitHub на готовые решения, и картировать ПО ВСЕМУ проекту. Триггер — две живые жалобы:
> (1) таск-статус отстаёт/не виден; (2) агент «не заёбывается» (рано сдаётся, недо-тщателен).
>
> Метод: 10-агентный workflow — 4 линии свежей теории + 2 GitHub-обзора + 3 картирования кода → синтез.

## Главный вывод

**Обе жалобы — не два бага, а ОДИН корень:** раздутый/устаревший контекст деградирует и КАЧЕСТВО, и
УПОРСТВО ЗАДОЛГО до жёсткого лимита. Лечится context-management'ом + внешне-видимым stateful-прогрессом,
**НЕ** нуджами «старайся сильнее» и **НЕ** апгрейдом модели.

**Джарвис уже реализует бóльшую часть SOTA-паттернов 2025-26** (hybrid recall, provenance-хедж,
untrusted-обёртки, fused-observe, replay-gate, проактивный context-guard, code-as-harness/SDK — местами
опережает индустрию). **Дельта узкая:** реранкер, observation-masking вместо hard-wrap, контракт подцелей,
intra-round статус, recency-first-class.

## Ключевые принципы (свежие, с источниками)

1. **Context rot бьёт с ~50K токенов, не у лимита 185K** (Chroma, 18 моделей, 2025-07): attention dilution
   + lost-in-the-middle (30%+ спад в середине) + интерференция дистракторов (даже ОДИН роняет точность;
   Claude галлюцинирует меньше всех ~2-3%, склонен воздерживаться). Резать по РЕЛЕВАНТНОСТИ и раньше, не
   только по объёму. → `https://www.trychroma.com/research/context-rot`
2. **Observation masking > LLM-суммаризация** (JetBrains «Complexity Trap», NeurIPS 2025): суммаризация
   СГЛАЖИВАЕТ сигналы провала/решённости → агент теряет точку остановки (+13-15% лишних ходов); маскирование
   старых re-fetchable дампов (сохраняя tool_call + reasoning + verify-сигнал) бьёт её (+2.6% solve, −52%
   cost). Валидирует отказ Джарвиса от autoCompact. → `https://arxiv.org/html/2508.21433v1`
3. **Упорство ≠ качество без ВИДИМОГО stateful-прогресса** (Push Your Agent / QGP, 2026-05): голое
   блокирование ложного «готово» = НОЛЬ пользы. Работает только контроллер с done/pending/remaining в
   КАЖДОМ наблюдении, блокирующий терминал при remaining>0. ОДИН механизм (backlog подцелей) чинит и
   упорство (#2), и наблюдаемость (#1). → `https://arxiv.org/html/2605.23574`
4. **Больше thinking активно ВРЕДИТ** — немонотонная перевёрнутая-U (пик ~1100 ток, спад до 70% на 16K).
   Эффорт/эскалацию триггерить СИГНАЛОМ застревания, не длиной задачи и не нетерпением.
5. **Эффорт по классу шага ПРЕДиктивно** (Ares, 2026-03): high только на recovery/backtrack/replan =
   45-53% экономии при равной точности — не реактивно по полному провалу раунда, как §7 сейчас.
6. **Настойчивость С ПЕРЕСМОТРОМ, не тупой ретрай**: при N провалах форсить СМЕНУ стратегии/инструмента/
   ступени наблюдения, а не повтор того же на более сильном тире.
7. **Верификация ОБЯЗАНА быть внешней** (Anthropic: 28% reward-хаков не вербализуются; environmental
   hardening −87.7% хакинга без падения успеха). Вектор Джарвиса (fused-observe) верен — усилить метрикой
   «ok=true подтверждён НАБЛЮДЕНИЕМ, а не текстом».
8. **Ретривал: retrieve-wide → rerank-narrow.** Cross-encoder реранкер (+5-15 NDCG, <200мс) режет
   дистракторы у порога 0.82 дешевле смены эмбеддера. Recency+salience — first-class (salience пишется, но
   ORDER BY игнорирует).
9. **False recall рождается на ЗАПИСИ, не только чтении** (arXiv 2606.10949): консолидация должна сохранять
   ПАРУ (утверждение+поправка/исход). Авто-помечать старый факт stale при конфликте сущность/предикат.
10. **Важные инструкции не закапывать в середину промпта** — lost-in-the-middle реален даже на 1M-моделях.
    Pin исходной цели задачи, впрыскивать хвостом каждый раунд (как §Б3 live-refresh).

## GitHub-решения — что перенять (не портировать)

| Репо | Идея | Для Джарвиса |
|---|---|---|
| **JetBrains the-complexity-trap** + Anthropic `clear_tool_uses` | Observation masking: заменять старые дампы на `[cleared]`, сохраняя tool_call+reasoning+verify | Заменить аварийный hard-wrap на детерминированное маскирование старых re-fetchable screen/OCR/browser-дампов. Обобщить `JARVIS_KEEP_SCREENSHOTS` |
| **OpenCode-goal-plugin** + Push Your Agent QGP | Evidence-gated persistence: терминал только при `[goal:evidence]+[goal:complete]`; видимый verifier-счёт | Заменить скаляр `anyMutateSucceeded` + одноразовый `goalCheckDone` на реестр подцелей {pending/done/failed/verified}+target |
| **mem0 v3** + bge-reranker (ONNX) | Fused retrieval (semantic+BM25+entity) + cross-encoder реранк | Расширить `LEXICAL_WEIGHT` до BM25+entity; реранкер на top-15→top-3-5 (тот же DirectML-стек) |
| **letta (MemGPT)** | Саморедактируемые memory-blocks всегда в контексте («RAM») | Editable-progress-block ↔ `task.status` — цель не вымывается + панель синхронна. Только паттерн, не сервер |
| **ag-ui-protocol** (MIT) | События агент→UI: `TOOL_CALL_START` (мгновенно), `STATE_DELTA` (шаг k/n) | Перенять модель событий поверх своего WS — чинит жалобу #1 (сейчас «шаг»=номер раунда, панель замирает) |
| **cognee** | Вся память в PG+pgvector + авто-роутинг Recall + Improve | Ближайший по стеку (PG18+pgvector, без Docker). Авто-роутинг episodic+skills+recipes; Improve = авто-запись рецепта |
| **Zep/graphiti** + FadeMem | Bi-temporal валидность (новый факт авто-инвалидирует старый) + recency/salience-забывание | Дешёвый приём: авто-stale старого факта при конфликте сущность/предикат; recency-decay в `episodic.search` |

## Приоритизированный план

### P0
- **Observation masking вместо hard-wrap** — маскировать старые re-fetchable наблюдения по проекции токенов
  (~50-64K, двухстадийно), сохраняя tool_use+reasoning+verify. GUI-скрины осторожнее research-дампов.
  Файлы: `brain/agent/index.ts` (context-guard, prune-images, KEEP_SCREENSHOTS), `integrations/anthropic.ts`.
- **Контракт подцелей (subgoal ledger)** — модель эмитит чек-лист подцелей с target-count; петля держит
  per-подцель статус, впрыскивает backlog хвостом, НЕ терминирует при pending без честного отчёта. Заменяет
  скаляр `anyMutateSucceeded`. Файлы: `brain/tasks/task.ts`, `brain/agent/index.ts` (~2328/2134/2619).
- **Intra-round task-status** — `TOOL_CALL_START` синхронно с earcon + микро-нарратив; `STATE_DELTA` (шаг
  k/n) вместо пораундового полного снимка; `stepsTotal` для навыков. Файлы: `brain/agent/index.ts`
  (emitTaskStatus), `gateway/router-ws.ts`, `apps/client/main/renderer/task-panel.ts`, `tasks/narrate.ts`.

### P1
- **Cross-encoder реранкер + pin цели** — retrieve 15-20 → rerank → top-3-5; BM25/entity к гибриду; pin
  user-цели в working-memory (FIFO-40 вытесняет цель болтовнёй). Файлы: `memory/episodic.ts`,
  `memory/skill-recall.ts`, `memory/working.ts`. ⚠️ 2-й ONNX конфликтует с sherpa → сайдкар.
- **Эффорт/бюджет по классу + verify как жёсткий гейт** — effort на recovery/replan; адаптивные капы
  (не фикс MAX_VERIFY=2/MAX_RETRY=2/HARD_STEP_CAP=3/единый loopMaxMs); после критического действия
  форс-ограничить ход verify-инструментами (`tool_choice`); no-progress detector. Файлы: `brain/agent/index.ts`,
  `thinking-policy.ts`, `router/index.ts`.
- **Recency+salience first-class + анти-сикофантная запись** — `cos + w_rec·exp(-Δt) + w_sal·salience`;
  access-count реинфорс; авто-stale при конфликте; TTL/decay-sweep episodic. Файлы: `memory/episodic.ts`,
  `memory/user-memory.ts`, `proactive/consolidation.ts`.

### P2
- **JIT-retrieval тяжёлых дампов** (`tool_result_ref` + `context_read{ref,query}`) — крупный дамп в стор по
  ref, в контекст заголовок+N строк+ref. Файлы: `brain/tools/dispatch.ts`, `handlers/*`, `packages/tools`.
- **Гигиена инструментов + Hack-Free метрика** — namespace `web_*`→`jbrowser_*`, консолидация 5 «кликов»
  в SDK, метрика «ok подтверждён наблюдением», freshness-gate, синхронизация словаря `memory_write` kind.
  Файлы: `packages/tools`, `persona.md`, `obs/metrics.ts`, `dispatch.ts`.

## Открытые вопросы (решение владельца / живой замер)
1. Реранкер: 2-й onnxruntime конфликтует с sherpa на Windows → сайдкар (как speaker) или только e5-канал?
2. Observation masking vs prompt-кеш §15: какой порог + `exclude_tools` (memory/verify) минимизируют
   кеш-промахи? Держать ниже последнего cache-breakpoint или в некешируемом хвосте?
3. Насколько агрессивно маскировать GUI-наблюдения без потери состояния экрана (координаты = ложный успех)?
   Раздельный attention_window по toolEffect (neutral vs blind-mutate)?
4. Контракт подцелей — ко ВСЕМ задачам или только к мульти-элементным/с явным count? Порог сложности, чтобы
   не грузить «открой ютуб» чек-листом?
5. Независимый critic-проход для важных терминалов — оправдан на голосе только для необратимых задач? Или
   fused-observe + evidence-контракт достаточно?
6. Первоисточник «The Context Fails First» как arXiv-препринт НЕ подтверждён (тема раскрыта эквивалентами:
   Chroma, Complexity Trap, MAST, Atlan). Нужна ли дословная цитата или синтеза достаточно?

## Уже сделано в этой серии (адресует часть плана)
- Грундинг памяти: порог 0.82 калибр. + провенанс-хедж + `memory_forget` (частично P1-recency/anti-sycophancy).
- Проактивный context-guard (проекция) — фундамент под P0-masking (заменить wrap на mask).
- `knowledge_consult` честный промах; MCP-вывод → untrusted.
- Примирение нудж↔бюджет (часть P1-эффорт/бюджет).
- P0-A немедленный таск-чип (часть P0-intra-round-status); P0-B quality-эскалация (часть P1-verify-гейт).
