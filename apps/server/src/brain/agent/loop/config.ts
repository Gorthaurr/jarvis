// W3 «Петля»: пороги и капы петли, читаются из env ОДИН раз на задачу (без новых флагов JARVIS_* — только прежние).


export function loadLoopConfig(isConversational: boolean) {
  const INPUT_WAIT_MS = (() => {
    const n = Number.parseInt(process.env.JARVIS_INPUT_WAIT_MS ?? "", 10);
    return Number.isFinite(n) && n >= 1_000 ? n : 60_000;
  })();
  const STALE_INPUT_WAIT_MS = 10_000; // ждали дольше — экран считается устаревшим для слепых действий
  // Жёсткий кап шагов + предохранитель SpendGuard (max шагов/токенов/трат §14).
  // Б6: разговорный ход (smalltalk/вопрос) не уходит в 20-раундовую петлю — «да ты молодец» стоило $0.19
  // и 8 раундов. Ревью волны Б 4-й проход (#3): кап 3 ЛОМАЛ research-вопросы (роутер метит вопросы
  // conversational, а «что происходит с выборами» легитимно нужно web_search+web_fetch×N+синтез ≥3-6
  // раундов) → «переспросите» в тупик. Кап 12 режет откровенный runaway (50→12), но не рвёт многошаговый
  // ресёрч. Главная экономия Б6 — СТРУКТУРНАЯ (не §20-задача, чистый scope), не жёсткий кап.
  const HARD_STEP_CAP = isConversational ? 12 : 50;
  const loopMaxBaseMs = (() => {
    const n = Number.parseInt(process.env.JARVIS_TASK_MAX_MS ?? "", 10);
    return Number.isFinite(n) ? Math.min(1_800_000, Math.max(30_000, n)) : 240_000;
  })();
  // Гард переполнения контекст-окна (hardening; ревью learn-coding-agent 2026-07-15). Промпт растёт с
  // каждым tool-раундом (крупные web/OCR/browser-дампы), и на патологически длинной задаче следующий раунд
  // может упереться в ЖЁСТКИЙ HTTP 400 (max context ~200K) на середине — деньги в мусор, итог потерян.
  // Считаем по РЕАЛЬНОМУ размеру прошлого промпта (input+cache_read+cache_creation), детерминированно, БЕЗ
  // LLM-суммаризации (та ломала бы prompt-кеш §15 и могла выбросить состояние экрана → ложный успех).
  // SOFT → одноразовый нудж «сворачивайся»; HARD → ранний честный свёрток (частичный итог, не 400). Клампы
  // страхуют кривой env; HARD всегда > SOFT. Выключатель — задрать пороги (нулём не отключается намеренно).
  const CONTEXT_SOFT_TOKENS = (() => {
    const n = Number.parseInt(process.env.JARVIS_CONTEXT_SOFT_TOKENS ?? "", 10);
    return Number.isFinite(n) && n >= 20_000 ? n : 150_000;
  })();
  const CONTEXT_HARD_TOKENS = (() => {
    const n = Number.parseInt(process.env.JARVIS_CONTEXT_HARD_TOKENS ?? "", 10);
    return Number.isFinite(n) && n > CONTEXT_SOFT_TOKENS ? n : Math.max(CONTEXT_SOFT_TOKENS + 10_000, 185_000);
  })();
  const QUEUE_WAIT_MS = (() => {
    const n = Number.parseInt(process.env.JARVIS_QUEUE_WAIT_MS ?? "", 10);
    return Number.isFinite(n) && n >= 5_000 ? n : 90_000;
  })();
  const liveRefreshOn = process.env.JARVIS_LIVE_CONTEXT_REFRESH !== "0";
  const ESCALATE_AFTER = 2;
  const FAMILY_SOFT_CAP = (() => {
    const n = Number.parseInt(process.env.JARVIS_TOOL_FAMILY_CAP ?? "", 10);
    return Number.isFinite(n) && n >= 3 ? n : 6;
  })();
  const MAX_FAMILY_NUDGES = 1;
  // §скорость (зрение): в контексте держим только N последних скринов (каждый ~2K токенов, старые —
  // мёртвый груз: модель обязана опираться на СВЕЖИЙ кадр). env JARVIS_KEEP_SCREENSHOTS, кламп [1,8].
  // Волна 1: деф 2→1 — prune мутирует ЗАКЕШИРОВАННУЮ историю (перезапись префикса); с 1 скрином
  // вырезание бьёт по САМОЙ СВЕЖЕЙ позиции (мельче перезапись) и экономит ~2K токенов входа.
  const KEEP_SCREENSHOTS = (() => {
    const n = Number.parseInt(process.env.JARVIS_KEEP_SCREENSHOTS ?? "", 10);
    return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 1;
  })();
  // §3.9: страницы документов (file_view) — ОТДЕЛЬНЫЙ бюджет: они не устаревают, как скриншоты, но
  // тоже ~2K токенов каждая; сравнение двух страниц требует держать ≥2. env JARVIS_KEEP_DOC_IMAGES, кламп [1,8].
  // §режим выделения: кроп области — ОТДЕЛЬНЫЙ бюджет от скриншотов. При общем keep=1 пара «деталь
  // (view) + контекст (screen_capture)» никогда не лежала в контексте вместе — каждый добор одного
  // вырезал другой (пинг-понг, адверс-ревью 2026-09-05). env JARVIS_KEEP_SELECTION_VIEWS, кламп [1,4].
  const KEEP_SELECTION_VIEWS = (() => {
    const n = Number.parseInt(process.env.JARVIS_KEEP_SELECTION_VIEWS ?? "", 10);
    return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1;
  })();
  const KEEP_DOC_IMAGES = (() => {
    const n = Number.parseInt(process.env.JARVIS_KEEP_DOC_IMAGES ?? "", 10);
    return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 2;
  })();
  const roundThinkingEnabled = process.env.JARVIS_ROUND_THINKING !== "0";
  // §Волна3 (3.2) executor-ступень: откуда §7-эскалация подняла тир (для отката на механике);
  // strongLocked — сила выбрана ОСОЗНАННО (trading/анти-капитуляция), вниз не спускаемся;
  // cleanRoundsStreak — чистые раунды подряд (сбрасывается провалом/нуджем).
  const executorDownshiftEnabled = process.env.JARVIS_EXECUTOR_TIER !== "0";
  const MAX_CONTINUATIONS = (() => {
    const n = Number.parseInt(process.env.JARVIS_MAX_CONTINUATIONS ?? "", 10);
    return Number.isFinite(n) && n >= 0 && n <= 20 ? n : 6;
  })();
  const MAX_RETRY_NUDGES = (() => {
    const n = Number.parseInt(process.env.JARVIS_MAX_RETRY_NUDGES ?? "", 10);
    // P0.3: нижняя граница 1, не 0 — «не сдавайся» нельзя тихо выключить кривым .env (это LAW №1).
    return Number.isFinite(n) && n >= 1 && n <= 3 ? n : 2;
  })();
  // P0.2: было жёстко 1 (сработав однажды, дальше не давил — конфабуляция второго действия проходила).
  // Теперь из env, дефолт 2, кламп [1,5] — verify обязателен СТРУКТУРНО, а не «один раз и забыли».
  /** Структурные «глаза»: читают дерево элементов, а не пиксели (дёшево, точно, с именами и состояниями). */
  const STRUCTURAL_SENSORS = new Set(["ui_snapshot", "browser_inspect", "browser_read", "screen_read_text", "context_read", "ui_ground"]);
  const MAX_VERIFY_NUDGES = (() => {
    const n = Number.parseInt(process.env.JARVIS_MAX_VERIFY_NUDGES ?? "", 10);
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 2;
  })();
  const MACRO_TRACE_TOOLS = new Set(["app_focus", "input_click", "input_key", "input_type", "act"]); // W4: act с разрешёнными координатами компилируется в реплей
  return { INPUT_WAIT_MS, STALE_INPUT_WAIT_MS, HARD_STEP_CAP, loopMaxBaseMs, CONTEXT_SOFT_TOKENS, CONTEXT_HARD_TOKENS, QUEUE_WAIT_MS, liveRefreshOn, ESCALATE_AFTER, FAMILY_SOFT_CAP, MAX_FAMILY_NUDGES, KEEP_SCREENSHOTS, KEEP_SELECTION_VIEWS, KEEP_DOC_IMAGES, roundThinkingEnabled, executorDownshiftEnabled, MAX_CONTINUATIONS, MAX_RETRY_NUDGES, STRUCTURAL_SENSORS, MAX_VERIFY_NUDGES, MACRO_TRACE_TOOLS };
}

export type LoopConfig = ReturnType<typeof loadLoopConfig>;
