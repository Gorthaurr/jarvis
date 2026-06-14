/**
 * Агент-цикл brain (§7, §8, §15, §21).
 *
 * Поток:
 *   1. classifyTier (router §7). tier0 «открой/запусти X» → ActionCommand round-trip (M0).
 *   2. Иначе — agent-loop на выбранном тире:
 *      retrieval из эпизодической памяти (§8) → системный промпт (персона §11 + факты)
 *      → LLM с инструментами (§6, §12) → исполнение tool-use (dispatchTool) → повтор
 *      до финального текста. Предохранитель — SpendGuard (max шагов/токенов §14).
 *   3. Финальный текст → verbalize (§21) → {voice, display?}.
 *
 * Эскалация тира (§7): тир выбирается ДО генерации (Haiku-классификатор/эвристика);
 * если сложность всплыла в петле — это место для филлера «секунду» и продолжения на
 * старшем тире (// TODO: динамическая эскалация).
 */
import type { ActionCommand, TaskStatus } from "@jarvis/protocol";
import { DEFAULT_ACTION_TIMEOUT_MS, newId } from "@jarvis/protocol";
import { type Logger, type Tier, createLogger } from "@jarvis/shared";
import { TOOL_SCHEMAS } from "@jarvis/tools";
import { buildActionLogEntry, insertActionLog } from "../../db/action-log.js";
import type { Session } from "../../gateway/session.js";
import type { ILlmProvider, LlmContentBlock, LlmMessage } from "../../integrations/llm.js";
import type { IWebProvider } from "../../integrations/web.js";
import type { EpisodicMemory } from "../../memory/episodic.js";
import type { WorkingMemory } from "../../memory/working.js";
import type { SpendGuard } from "../../billing/index.js";
import { type UserContextSlot, buildSystemPrompt } from "../persona/index.js";
import { setDisplayName } from "../profile.js";
import { type LocalIntent, classifyTier } from "../router/index.js";
import { dispatchTool } from "../tools/dispatch.js";
import { verbalize } from "../verbalize/index.js";
import { TaskManager } from "../tasks/manager.js";
import type { Task } from "../tasks/task.js";
import { SessionWarmth } from "./warmth.js";

const log: Logger = createLogger("agent");

/** Тёплость сессий по умолчанию (§15), если не инъектирован общий через deps. */
const sharedWarmth = new SessionWarmth();

/** Ответ агента по схеме §21. */
export interface AgentReply {
  voice: string;
  display?: { title?: string; markdown: string };
}

/** Зависимости агента (инъекция для тестируемости и разделения слоёв). */
export interface AgentDeps {
  memory: WorkingMemory;
  llm: ILlmProvider;
  episodic: EpisodicMemory;
  web: IWebProvider;
  /** id моделей по тирам (§7). */
  models: Record<Exclude<Tier, "tier0">, string>;
  spend: SpendGuard;
  userId: string;
  userContext?: UserContextSlot;
  /**
   * Реестр долгих задач (§20). ОБЩИЙ с router-ws: команды «отмени»/«пауза» из UI
   * мутируют cancel-флаг той же задачи, которую держит петля. Опционален — если не
   * передан, петля заводит локальный реестр (для изолированных тестов).
   */
  tasks?: TaskManager;
  /** Тёплость сессий для §15-кеширования (общая с gateway); по умолчанию — модульная. */
  warmth?: SessionWarmth;
}

/** Инструменты, не предлагаемые модели в диалоге (инициируются иначе). */
const EXCLUDED_TOOLS = new Set(["skill_execute", "demo_record"]);

/** «Зови меня X / меня зовут X / обращайся ко мне X» → имя (детерминированно, без LLM). */
const NAME_RE =
  /(?:обращайся ко мне|зови меня|называй меня|меня зовут|мо[её] имя)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]{1,19})/iu;
function extractName(text: string): string | null {
  const m = NAME_RE.exec(text);
  if (!m?.[1]) return null;
  const raw = m[1].replace(/[.!?,]+$/u, "");
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

export async function handleUserText(
  session: Session,
  text: string,
  deps: AgentDeps,
): Promise<AgentReply> {
  const clean = text.trim();
  deps.memory.pushTurn("user", clean);

  // Память (§8/§11): пользователь представился → запоминаем имя НАВСЕГДА (профиль на диске),
  // подставляем в персону текущей сессии. Больше не спрашиваем при каждом запуске.
  const name = extractName(clean);
  if (name) {
    void setDisplayName(name);
    if (deps.userContext) deps.userContext.displayName = name;
    else deps.userContext = { displayName: name };
    const reply: AgentReply = { voice: verbalize(`Запомнил, ${name}. Рад знакомству.`) };
    deps.memory.pushTurn("assistant", reply.voice);
    return reply;
  }

  // Фоновая запись реплики в эпизодическую память (контекст будущих сессий, §8).
  if (clean.length > 3) {
    void deps.episodic
      .write({ userId: deps.userId, kind: "event", text: clean, ts: Date.now() })
      .catch(() => undefined);
  }

  const decision = classifyTier(clean);
  log.info("маршрутизация", { tier: decision.tier, reason: decision.reason });

  let reply: AgentReply;
  if (decision.tier === "tier0" && decision.local) {
    reply = await runLocalIntent(session, decision.local);
  } else {
    const tier: Exclude<Tier, "tier0"> = decision.tier === "tier0" ? "haiku" : decision.tier;
    reply = await runAgentLoop(session, clean, tier, deps);
  }

  deps.memory.pushTurn("assistant", reply.voice);
  return reply;
}

/** Полный agent-loop с tool-use (§7, §8). */
async function runAgentLoop(
  session: Session,
  text: string,
  tier: Exclude<Tier, "tier0">,
  deps: AgentDeps,
): Promise<AgentReply> {
  const model = deps.models[tier];

  // Долгая задача (§20): общий с router реестр (или локальный для изолированных тестов).
  const tasks = deps.tasks ?? new TaskManager();
  const task = tasks.create({ userId: deps.userId, sessionId: session.sessionId, goal: text });
  const taskId = task.taskId;
  // Прогресс показываем (панель + кнопка «стоп» в renderer) только когда задача реально
  // многошаговая (пошёл tool-use) — чтобы не мигать панелью на простых ответах (§20).
  let shown = false;
  const showStatus = (): void => {
    shown = true;
    emitTaskStatus(session, task);
  };

  // Retrieval-augmentation: релевантные факты из эпизодической памяти (§8).
  let facts: string[] = [];
  try {
    const hits = await deps.episodic.search(deps.userId, text, 5);
    facts = hits.map((h) => h.episode.text);
  } catch (e) {
    log.debug("retrieval недоступен", e instanceof Error ? e.message : String(e));
  }

  const sys = buildSystemPrompt({ ...deps.userContext, facts });
  const tools = TOOL_SCHEMAS.filter((t) => !EXCLUDED_TOOLS.has(t.name));

  // Контекст диалога из рабочей памяти (§8).
  const convo: LlmMessage[] = deps.memory
    .recentTurns()
    .map((t) => ({ role: t.role, content: t.text }) as LlmMessage);

  const toolCtx = {
    session,
    web: deps.web,
    episodic: deps.episodic,
    userId: deps.userId,
    // Подтверждение необратимого (§14) — для message_send (UC-2).
    confirm: (summary: string) =>
      session
        .requestConfirm({ requestId: newId(), summary, kind: "send", expiresAt: Date.now() + 60_000 })
        .then((r) => ({ approved: r.approved, revision: r.revision })),
  };
  let finalText = "";

  // Жёсткий кап шагов + предохранитель SpendGuard (max шагов/токенов/трат §14).
  const HARD_STEP_CAP = 50;
  let cancelled = false;
  let limited = false;
  let round = 0; // число завершённых tool-use раундов (= прогресс задачи)
  let cacheReadTokens = 0; // метрики prompt-кеша за задачу (§15)
  let cacheCreationTokens = 0;
  for (let step = 0; step < HARD_STEP_CAP; step += 1) {
    // Отмена ≤1 шага (§20): cancel-флаг проверяется ПЕРЕД каждым шагом. Команда
    // «отмени» из router мутирует ТОТ ЖЕ флаг между await'ами петли.
    if (task.cancel.cancelled) {
      cancelled = true;
      break;
    }

    const guard = deps.spend.check(taskId, 0.01, 2000);
    if (!guard.allowed) {
      log.warn("предохранитель остановил петлю", { reason: guard.reason });
      limited = true;
      break;
    }

    // §15: кешируем префикс только в «тёплой» сессии. Первый вызов холодной
    // сессии — тощий префикс без кеша (не платить 1.25× за разовую перезапись);
    // последующие в петле — уже тёплые. Кеш-брейкпоинт растущего диалога — только
    // когда кешируем (system+tools кешируются статичным брейкпоинтом в anthropic.ts).
    const warmth = deps.warmth ?? sharedWarmth;
    const cachePrefix = step === 0 ? warmth.isWarm(session.sessionId) : true;
    if (cachePrefix) markCacheBreakpoint(convo);

    const resp = await deps.llm.complete({
      tier,
      model,
      systemStatic: sys.staticPrefix,
      systemDynamic: sys.dynamicSuffix || undefined,
      messages: convo,
      tools,
      cachePrefix,
    });
    warmth.touch(session.sessionId);
    deps.spend.recordStep(taskId);
    deps.spend.recordUsage(taskId, resp.usage.inputTokens + resp.usage.outputTokens, estimateCost(resp.usage));
    cacheReadTokens += resp.usage.cacheReadTokens;
    cacheCreationTokens += resp.usage.cacheCreationTokens;

    if (resp.toolUses.length === 0) {
      finalText = resp.text || "Готово.";
      break;
    }

    // Пошёл tool-use → это настоящая многошаговая задача: показываем прогресс (§20).
    if (!shown) showStatus();

    // Реплеим ход ассистента (текст + tool_use) и результаты инструментов.
    const assistantBlocks: LlmContentBlock[] = [];
    if (resp.text) assistantBlocks.push({ type: "text", text: resp.text });
    for (const tu of resp.toolUses) {
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    convo.push({ role: "assistant", content: assistantBlocks });

    const resultBlocks: LlmContentBlock[] = [];
    for (const tu of resp.toolUses) {
      const r = await dispatchTool(tu.name, tu.input, toolCtx);
      log.info("tool", { name: tu.name, isError: r.isError });
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      });
    }
    convo.push({ role: "user", content: resultBlocks });

    round += 1;
    tasks.progress(taskId, round);
    if (shown) emitTaskStatus(session, task);
  }

  deps.spend.finishTask(taskId);
  if (cacheReadTokens + cacheCreationTokens > 0) {
    log.info("prompt-кеш (§15)", { cacheReadTokens, cacheCreationTokens });
  }

  // Терминал задачи (§20): отмена / лимит / успех — со стримом task.status.
  if (cancelled) {
    // state уже "cancelled" (выставил router через tasks.cancel) — досылаем финальный статус.
    if (shown) emitTaskStatus(session, task);
    return { voice: verbalize("Хорошо, остановил.") };
  }
  if (limited) {
    tasks.fail(taskId, "достигнут лимит на задачу (spend cap §14)");
    if (shown) emitTaskStatus(session, task);
    return { voice: verbalize("Остановился — достигнут лимит на задачу.") };
  }
  if (!finalText) finalText = "Готово.";
  tasks.finish(taskId, finalText);
  if (shown) emitTaskStatus(session, task);
  return { voice: verbalize(finalText) };
}

/** Стрим прогресса/состояния задачи на клиент (§20, task.status → renderer-панель). */
function emitTaskStatus(session: Session, task: Task): void {
  const payload: TaskStatus = {
    taskId: task.taskId,
    state: task.state,
    summary: task.goal,
    stepsDone: task.stepsDone,
    stepsTotal: task.stepsTotal,
  };
  session.send("task.status", payload);
}

/** tier0: локальный интент как одно действие round-trip (§5). */
async function runLocalIntent(session: Session, intent: LocalIntent): Promise<AgentReply> {
  const command = intentToCommand(intent);
  const result = await session.sendAction(command, DEFAULT_ACTION_TIMEOUT_MS);
  void insertActionLog(buildActionLogEntry(session.sessionId, result.commandId, command, result));
  if (result.ok) return { voice: verbalize(successPhrase(intent)) };
  log.warn("локальное действие не удалось", { kind: command.kind, code: result.error?.code });
  return { voice: verbalize(failurePhrase(intent, result.error?.code)) };
}

function intentToCommand(intent: LocalIntent): ActionCommand {
  switch (intent.kind) {
    case "app.launch":
      return { kind: "app.launch", app: intent.app };
    case "app.focus":
      return { kind: "app.focus", app: intent.app };
    case "browser.open":
      return { kind: "browser.open", url: intent.url };
  }
}

function successPhrase(intent: LocalIntent): string {
  switch (intent.kind) {
    case "app.launch":
      return `Открыл ${intent.app}.`;
    case "app.focus":
      return `Переключился на ${intent.app}.`;
    case "browser.open":
      return "Открыл.";
  }
}

function failurePhrase(intent: LocalIntent, code?: string): string {
  const reason =
    code === "timeout"
      ? "не дождался ответа"
      : code === "not_found"
        ? "не нашёл"
        : code === "disconnected"
          ? "связь с клиентом прервалась"
          : "не получилось";
  switch (intent.kind) {
    case "app.launch":
      return `Не вышло открыть ${intent.app}: ${reason}.`;
    case "app.focus":
      return `Не вышло переключиться на ${intent.app}: ${reason}.`;
    case "browser.open":
      return `Не вышло открыть страницу: ${reason}.`;
  }
}

/**
 * Грубая оценка стоимости вызова (для spend cap §14). Порядок величины в
 * нормализованных единицах: вход=1, кеш-чтение=0.1, кеш-запись=1.25, выход=5 —
 * отражает экономию prompt-кеша (§15).
 */
function estimateCost(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    (usage.inputTokens * 1 +
      usage.cacheReadTokens * 0.1 +
      usage.cacheCreationTokens * 1.25 +
      usage.outputTokens * 5) /
    1_000_000
  );
}

/**
 * Кеш-брейкпоинт растущего диалога (§15): держим РОВНО одну метку — на последнем
 * блоке последнего сообщения. Прежние снимаем, чтобы не упереться в лимит
 * брейкпоинтов Anthropic (≤4). Первый ход (content — строка) пропускаем.
 */
export function markCacheBreakpoint(convo: LlmMessage[]): void {
  for (const m of convo) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "text" || b.type === "tool_result") delete b.cache_control;
    }
  }
  const last = convo.at(-1);
  if (!last || typeof last.content === "string") return;
  const lastBlock = last.content.at(-1);
  if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_result")) {
    lastBlock.cache_control = { type: "ephemeral" };
  }
}
