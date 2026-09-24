// W3 «Петля»: сборка системного промпта задачи (персона, тон, факты с провенансом, навык, каталог, паспорт).
import { RECENT_TASKS_WINDOW_MS, formatRecalledSkill } from "./util.js";
import type { LoopCtx } from "./context.js";
import type { AgentDeps, LoopOpts } from "../types.js";
import { formatSelectionContext } from "../selection-context.js";
import { buildSystemPrompt } from "../../persona/index.js";
import { getProfile, readFactMeta } from "../../profile.js";
import { withFactAges } from "../../../memory/fact-age.js";
import { getMode } from "../../persona/modes.js";
import { emotionOverlay } from "../../persona/emotion.js";
import { formatActiveTasks, formatRecentTasks } from "../../tasks/task.js";

export interface PromptInput { deps: AgentDeps; opts: LoopOpts | undefined; tasks: LoopCtx["tasks"]; taskId: string; recalled: LoopCtx["recalled"]; facts: string[]; skillCatalog: string }

export async function buildPrompt(input: PromptInput) {
  const { deps, opts, tasks, taskId, recalled, facts, skillCatalog } = input;
  // Тон = оверлей режима-маски (§11) + оверлей эмоции подачи (§21), оба из профиля (переживают
  // рестарт). Эмоция просит LLM подобрать СЛОВА под подачу (голос несёт её отдельно ролью TTS).
  const profile = getProfile(deps.userId);
  const personaTone =
    [getMode(profile.mode).overlay, emotionOverlay(profile.emotion)].filter(Boolean).join("\n\n") || undefined;
  // §20 «осознание задач»: (а) АКТИВНЫЕ задачи в полёте (кроме текущего хода) — чтобы на «сделал?» во
  // время фоновой работы ответить «ещё в работе», а не «ничего не делаю»; (б) последние ТЕРМИНАЛЬНЫЕ
  // из общего реестра (диск-персист §5, переживают рестарт) в окне retention — фактический ответ на
  // «что делал?». Оба блока — в НЕкешируемый хвост промпта (кеш §15 не трогаем).
  const nowMs = Date.now();
  const recentTasks = [
    formatActiveTasks(tasks.activeForUser(deps.userId, taskId, deps.devSession === true), nowMs),
    // windowMs → блок явно называет ГРАНИЦЫ памяти: «не вижу» не должно превращаться в «этого не было»
    // (живой провал 2026-07-25 — категоричное «я не отправлял» о вчерашней реальной отправке).
    formatRecentTasks(tasks.recentTerminal(deps.userId, { limit: 5, maxAgeMs: RECENT_TASKS_WINDOW_MS }), nowMs, RECENT_TASKS_WINDOW_MS),
  ]
    .filter(Boolean)
    .join("\n\n");
  // ПРОВЕНАНС фактов (аудит контекста 2026-07-20). Раньше курируемые факты профиля и эпизодический
  // retrieval плоско мержились в один блок «Известные факты» — низкоуверенный сосед на шумном e5-small
  // читался моделью как ТВЁРДЫЙ факт («вспоминает то, чего не было»). Теперь РАЗДЕЛЕНО:
  //  • profile.facts → asserted «Известные факты» (курируемые; сохраняет фикс А1 — доходят всегда);
  //  • эпизодический recall (уже отсечён порогом memoryMinScore) → ОТДЕЛЬНЫЙ хеджированный блок
  //    «возможно, из прошлых разговоров — сверься» (persona/index.ts renderDynamic), с дедупом против
  //    курируемых (не двоим то, что уже asserted). Профиль читаем ЖИВЬЁМ из кеша (факты этой сессии).
  const curatedFacts = getProfile(deps.userId).facts ?? [];
  const curatedSet = new Set(curatedFacts.map((f) => f.trim().toLowerCase()));
  // Волна H (шаг 1): к КАЖДОМУ курируемому факту печатаем его возраст. Без этого два противоречащих
  // факта («работает в Сбере» / «…в Яндексе» — косинус ниже дедуп-порога, поэтому оба в сторе)
  // выглядели для модели равноправными, и она уверенно называла устаревшее в ДОВЕРЕННОМ блоке.
  // Свежесть считает КОД (у модели это слабое место); карта провенанса — sidecar волны F.
  const factMeta = await readFactMeta(deps.userId).catch(() => new Map<string, { source: string; ts?: number }>());
  const datedFacts = withFactAges(curatedFacts, factMeta, Date.now());
  const recalledMemories = facts.filter((t) => !curatedSet.has(t.trim().toLowerCase()));
  // §econ (лог-анализ 2026-07-21): тривиальный smalltalk («привет») не требует полной 33К-персоны — на холодном
  // кеше (тир-свитч) это ~$0.2/ход, 11% трат. LEAN-ядро (~500 ток) за флагом; дефолт — полная персона (0 регресс).
  const lean = opts?.smalltalk === true && process.env.JARVIS_LEAN_SMALLTALK === "1";
  const selectionLine = formatSelectionContext(deps.selection?.get(), Date.now());
  const sys = buildSystemPrompt(
    {
      ...deps.userContext,
      facts: datedFacts,
      ...(recalledMemories.length ? { recalledMemories } : {}),
      personaTone,
      ...(recalled ? { learnedSkill: formatRecalledSkill(recalled) } : {}),
      ...(skillCatalog ? { skillCatalog } : {}),
      ...(recentTasks ? { recentTasks } : {}),
      // Волна E: паспорт возможностей — живой снимок «что доступно СЕЙЧАС» (расширение/MCP/ключи/
      // killswitch). Честность ДО провала: модель не обещает мёртвый канал. Некешируемый хвост.
      ...(deps.capabilities ? { capabilities: deps.capabilities() } : {}),
      // §режим выделения: указатель владельца «вот тут» — факт, размер, монитор и ВОЗРАСТ указания.
      // Содержимое области сюда не попадает: его модель добывает свежим кадром (screen_selection).
      ...(selectionLine ? { selection: selectionLine } : {}),
    },
    { lean },
  );
  return sys;
}
