# Reasoning-фреймворки (GoT и соседи) → проекция на Jarvis

> Источник: многоагентное исследование 2026-06-23 (13 агентов, 6 кластеров, research+adversarial-verify+synthesis).
> Повод — Graph of Thoughts (spcl/ETH, AAAI 2024). Цель — найти подходы к реализации/доработке Jarvis.
>
> ⚠️ Часть точных цифр верификатор пометил как неподтверждённые/оценочные (помечены «(оценка)»).
> Качественные выводы и механика — подтверждены по первоисточникам.

## Главная ось анализа (она же — главное ограничение Jarvis)
Все «of-Thoughts»/агентные схемы делятся по ОДНОМУ признаку, критичному для голоса:
**множат ли они число LLM-вызовов на один ход.** Голосовой ход у Jarvis = генерация Opus 2–13с
(не TTS). Любое ветвление/голосование/поиск умножает это на N → минуты вместо секунд.

| Класс | Схемы | Вызовов/ход | Для Jarvis |
|---|---|---|---|
| Мульти-вызовные деревья/графы | ToT, GoT, RAP, LATS, MCTS, Self-Consistency, CoVe, Self-Refine | десятки–сотни | ❌ горячий путь · ✅ фон §20 (если задача декомпозируема-и-сливаема) |
| Одно/двух-вызовные | AoT (1 вызов), **BoT** (retrieve+instantiate), ReWOO (план без наблюдений), **LLMCompiler** (параллельный DAG), **Skeleton-of-Thought** | 1–2 + параллелизм | ✅ при ограничениях |
| Чистые латентные рычаги | prompt/KV-кеш, difficulty-router, спекулятивная предзагрузка read-инструментов, sleep-time compute, ConvFill-филлер | ≤1 | ✅ прямо в горячий путь |

**Вывод:** для Jarvis ценны не «много мыслей-кандидатов», а (1) **структура GoO/GRS** (план vs состояние),
(2) **LATS-петля** act→РЕАЛЬНОЕ наблюдение→рефлексия (изоморф verify-loop + зрение + HERMES),
(3) весь латентный кластер. Ветвление/голосование/MCTS на горячем пути — запрещены.

## Что есть в Jarvis уже сейчас (изоморфы)
- **HERMES навык-процедура** ≈ **Buffer-of-Thoughts** thought-template (recall=retrieval, инжект в `systemSkill`=инстанцирование за 1 вызов).
- **Semaphore(3) на не-GUI + AsyncMutex на GUI** (§20) ≈ половина Executor'а **LLMCompiler** (параллель только независимых read'ов).
- **durable task-store §20** (переживает рестарт) ≈ **GRS** (Graph Reasoning State); **HERMES-навык** ≈ **GoO** (статичный план).
- **prompt-кеш §15** (cache_read 0.1×) ≈ чистый латентный рычаг (уже несущий).
- **visionFallbackHint + persona v22** («клик≠результат») ≈ зёрна **LATS/CoVe** verify-loop.
- **ButlerAcks** ≈ зачаток **ConvFill**-филлера.
- **screen_capture (зрение)** ≈ РЕАЛЬНАЯ обратная связь среды (LATS-транзишн, не воображаемый world-model RAP).

## Рекомендации (приоритет по latency-классу)

### safe_hotpath — можно на голосовом ходу
1. **Difficulty-gate вместо мёртвой §7-эскалации.** §7 (`agent/index.ts:842-867`) мертва (`nextModel===model` при all-Opus). Переосмыслить по compute-optimal scaling: лёгкие дворецкие ходы (открой/напомни/короткий Q&A) не выигрывают от лишнего reasoning. Расширить детерминированный `classifyTier` (`router/index.ts`, уже $0) → на лёгких ходах минимальный reasoning-бюджет. Рычаг — НЕ extended-thinking (Opus даёт HTTP 400), а ширина инструкции-на-краткость + маршрутизация в фон. *(medium)*
2. **HERMES → Buffer-of-Thoughts.** (a) на self-learn (`agent/index.ts:907-925`, fable) ДИСТИЛЛИРОВАТЬ процедуру в обобщённый шаблон, не сырой транскрипт (открытый TODO в `skills.ts`); (b) структурный retrieval по сигнатуре задачи вместо чисто-лексического `matchLearnedSkill` (`skills.ts:534`); (c) дедуп уже есть (`findDuplicateSkill`). BoT: ~12% стоимости мульти-вызовных при +11/+20/+51% качества (оценка из статьи). *(medium)*
3. **verify-loop как LATS-петля (n=1 на горячем пути).** После необратимого/GUI-действия — ОБЯЗАТЕЛЬНЫЙ независимый verify-шаг (`screen_capture`/`browser_read`) в ИЗОЛИРОВАННОМ контексте (принцип CoVe-факторизации: нельзя просить ту же оптимистичную петлю себя перепроверить). Провал → вербальный урок в навык (HERMES). Прямо усиливает honesty-on-error. *(medium)*
4. **Бесплатная детерминированная верификация исхода (code-Score/GroundTruth, 0 LLM-вызовов).** Где исход проверяем КОДОМ (файл→`fs.exists`; процесс→проверка в `apps.ts`; OBS→`Get*`; вкладка→`tab.read` aria-label, как в фиксе Я.Музыки) — возвращать в `ActionResult` ПРОВЕРЕННОЕ состояние, а не «команда ушла». Из GoT-операций самые ценные для Jarvis — именно нулевые по вызовам. *(medium)*
5. **Спекулятивная предзагрузка READ-инструментов под генерацию (PASTE).** Пока Opus генерит (2–13с), спекулятивно запускать вероятный следующий **идемпотентный** read (`screen_capture`/`browser_read`/`read_clipboard`/`memory_search`/`tool_load`/`monitor_list`). Предиктор — HERMES + resolution-memory. НИКОГДА не спекулировать write/GUI (нарушит закон честности). PASTE: до −48.5% E2E / −55.2% tool-латентности. Половина механизма есть (Semaphore/AsyncMutex). *(high)*
6. **LLMCompiler-DAG для параллельных независимых read'ов в одном ходу.** Несколько независимых read (screen+календарь+погода+web) — по DAG ПАРАЛЛЕЛЬНО, не серией. GUI-write остаётся сериализован. LLMCompiler: до 3.7× быстрее ReAct. *(medium)*
7. **Skeleton-of-Thought + пофразный TTS для редких ДЛИННЫХ списочных ответов.** Скелет-пункты → параллельное раскрытие → пофразный TTS (`JARVIS_VOICE_STREAMING`) озвучивает первый пункт, пока раскрываются остальные. SoT: до 2.39× wall-clock. SoT-Router защищает короткие реплики (3-7 слов — раскрывать нечего); НЕ для пошаговых/math. *(medium)*
8. **ConvFill: мгновенный content-free ack + тяжёлый ответ в фоне.** На финализации STT — мгновенный филлер («секунду, сэр»), голос продолжается из Opus по готовности (пофразный TTS). КРИТИЧНО: филлер произносит ТОЛЬКО безопасное-к-уточнению — НИКОГДА «инструмент сработал» (утверждения об успехе принадлежат только verify-loop). Уже частично: ack не пишется в рабочую память (`agent/index.ts:384-392`). *(medium)*
9. **Защита prompt-кеша §15 (Don't-Break-the-Cache).** Все волатильные блоки (последняя реплика, свежие tool-результаты, `recentTasks`-инжект §20) — строго в ХВОСТЕ `renderDynamic`; `tool_load` — дозаписью в хвост `tools[]` (rolling-breakpoint), без реордеринга набора (любая мутация порядка рушит кеш). Защищает уже-существующий выигрыш TTFT через все раунды tool-use. *(low)*

### background_only — только вне горячего пути (§20)
10. **Reflexion-метапетля вокруг фоновых задач §20.** Ретраибельные долгие задачи: провал по ВЕРИФИЦИРОВАННОМУ (не самооценочному!) сигналу → урок в pgvector/task-store → ретрай с уроком. Необратимые действия (отправленное сообщение, удалённый файл) ретраить НЕЛЬЗЯ. Reflexion: 91% pass@1 (оценка). Латентность ретрая в фоне невидима. *(medium)*
11. **GoT/GoO-структура (агрегация) для gather-and-synthesize.** Две вещи из GoT в §20: (a) **АГРЕГАЦИЯ** — то, чего дерево не умеет: параллельные Generate-ветви → СЛИЯНИЕ (медиана цены авто Avito∪Drom∪auto.ru, multi-source research, слияние документов), агрессивный прунинг (KeepBestN); (b) GoO/GRS-разделение (GRS=task-store, GoO=HERMES). НЕ строить GoO руками под каждую команду (конфликт с «не хардкодить шаги»), НЕ тащить мульти-кандидатную генерацию на актуацию. *(high)*
12. **Sleep-time compute: анти-вычисление в простое.** В idle (`powerMonitor.getSystemIdleTime`, уже в `user-presence.ts`) предвычислять вероятно-нужное (сводка дня, прогрев RAG, пред-резолв контактов) → голосовой ход читает дешёвую ноту вместо живого reasoning. ~5× меньше test-time-вычисления (оценка). *(high)*

### avoid_hotpath — ловушки
13. **Гард на барж-ин: длинный внутренний reasoning ломает прерываемость.** «Are LRMs Interruptible?»: при прерывании размышления до −60% точности. Длинный reasoning на горячем пути создаёт НЕпрерываемое окно 2–13с → разговор не перебить/поправить. Тяжёлое — в §20. *(low, кодифицировать в persona/CLAUDE.md)*

## Anti-patterns (что НЕ делать)
- **НЕ** ToT/GoT/MCTS/RAP/LATS-полный на горячий путь (десятки-сотни Opus-вызовов; ToT ~$0.74/кейс — оценка).
- **НЕ** Self-Consistency/голосование на дворецких ходах (ответы открытые/side-effecting; tail-latency = самый медленный сэмпл).
- **НЕ** строить GoO/планы РУКАМИ под сценарий (конфликт с законом «не хардкодить шаги»; роль графа играет ВЫУЧЕННЫЙ навык).
- **НЕ** мульти-кандидатную генерацию мыслей на актуацию ОС/браузера (необратимое действие нельзя сгенерить пачкой и выбрать лучшее — оно уже случилось).
- **НЕ** ReWOO-спекуляцию (план без наблюдений) на GUI-write (экран недетерминирован → спекулятивный «успех» = ложный = нарушение честности). Годится только для info-ходов с независимыми read.
- **НЕ** Self-Refine/CoVe-полный цикл ПЕРЕД речью (3-6 серийных вызовов; улучшает ТЕКСТ, не подтверждает изменение мира).
- **НЕ** просить ту же оптимистичную петлю себя перепроверить — нужен НЕЗАВИСИМЫЙ зонд (CoVe-факторизация).
- **НЕ** полагаться на speculative decoding (Medusa/EAGLE) для облачного Opus — это инфра-движок за закрытым API; только при локальной модели.

## Ключевые ссылки
- Graph of Thoughts: https://arxiv.org/abs/2308.09687 · repo https://github.com/spcl/graph-of-thoughts · операции https://github.com/spcl/graph-of-thoughts/blob/main/graph_of_thoughts/operations/README.md
- Tree of Thoughts: https://arxiv.org/abs/2305.10601 · LATS: https://arxiv.org/abs/2310.04406 · RAP: https://arxiv.org/abs/2305.14992
- ReAct: https://arxiv.org/abs/2210.03629 · Reflexion: https://arxiv.org/abs/2303.11366 · Self-Refine: https://arxiv.org/abs/2303.17651 · Self-Consistency: https://arxiv.org/abs/2203.11171 · CoVe: https://arxiv.org/abs/2309.11495
- Buffer of Thoughts: https://arxiv.org/abs/2406.04271 (repo https://github.com/YangLing0818/buffer-of-thought-llm) · Algorithm of Thoughts: https://arxiv.org/abs/2308.10379 · Skeleton-of-Thought: https://arxiv.org/abs/2307.15337 · XoT (Findings ACL 2024): https://aclanthology.org/2024.findings-acl.95/
- ReWOO: https://arxiv.org/abs/2305.18323 · LLMCompiler: https://arxiv.org/abs/2312.04511 (repo https://github.com/SqueezeAILab/LLMCompiler) · LangGraph: https://langchain-ai.github.io/langgraph/
- Compute-optimal test-time scaling: https://arxiv.org/abs/2408.03314 · Sleep-time compute: https://arxiv.org/abs/2504.13171
- ⚠️ требуют доппроверки точных цифр перед использованием: PASTE (speculative tool-exec), ConvFill (voice filler, ~ноя 2025), «Are LRMs Interruptible?», Don't-Break-the-Cache.
